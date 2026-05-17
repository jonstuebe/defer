import type { DurableObjectState } from "@cloudflare/workers-types";
import { type Event, EventSchema, type PendingEvent, RELAY_DEVICE_ID } from "@defer/core";
import {
  CancelDeletionRequestSchema,
  MAX_PAGE_SIZE,
  PushEventsRequestSchema,
  RegisterDeviceRequestSchema,
  ScheduleDeletionRequestSchema,
  type CancelDeletionResponse,
  type PushEventsResponse,
  type PullEventsResponse,
  type RegisterDeviceResponse,
  type RevokeDeviceResponse,
  type ScheduleDeletionResponse,
} from "@defer/core/relay-protocol";

import { requireBearerToken } from "./auth.js";
import type { Env } from "./env.js";
import { RelayError } from "./errors.js";

// Storage key prefixes / markers, pinned in code so issue #30 (deletion alarm)
// and issue #27 (device tokens) don't have to re-discover the layout. The
// schema:
//
//   meta:nextSeq           number          — next `seq` to assign (starts at 1)
//   meta:initialized       true            — existence marker for "has been bootstrapped"
//   meta:tombstone         TombstoneRecord — set by the deletion alarm (#30); checked
//                          | true            by every endpoint; permanent (no rebirth).
//                                            Issue #30 stores the structured shape
//                                            `{ deletedAt, vaultDeletedSeq }`. Earlier
//                                            code paths (and #29's test affordance)
//                                            may write a bare `true`; the runtime
//                                            check treats any truthy value as
//                                            tombstoned. The first alarm-fire on a
//                                            bare-`true` tombstone upgrades it to the
//                                            structured shape.
//   token:<token>          { deviceId }    — membership set: token validity + owning
//                                            deviceId (issue #27 upgraded the value
//                                            from a bare `true` to a JSON object so
//                                            the device list can be enumerated and
//                                            self-revoke can look up the owner)
//   device:<deviceId>      <token>         — reverse index: who owns this deviceId?
//                                            Used by DELETE /devices/:deviceId and
//                                            by POST /devices duplicate-id check.
//   event:<padded-seq>     Event           — full envelope with `seq` stamped. The seq
//                                            is zero-padded to 16 digits so prefix-range
//                                            scans return events in `seq` order without
//                                            a JS-side sort.
//   nonce:<deviceId>:<cn>  number          — the assigned seq; replay-protection index
//   meta:pendingVaultDeleted PendingVaultDeleted
//                                          — the pre-signed VaultDeleted envelope handed in
//                                            by the scheduling device (ADR-0006 §5). Set on
//                                            `POST /schedule-deletion`, deleted on
//                                            `POST /cancel-deletion`. Issue #30's alarm
//                                            reads this blob and re-emits it verbatim with
//                                            an assigned `seq`.
//   meta:scheduledFor      number          — ms timestamp mirror of `pendingVaultDeleted`'s
//                                            scheduledFor, kept as a separate scalar for
//                                            cheap in-DO "already scheduled?" checks.
//
// `deviceId` is base64url per the envelope schema (no `:` collision risk); the
// composite key is therefore safe to delimit with `:`.

const KEY_NEXT_SEQ = "meta:nextSeq";
const KEY_INITIALIZED = "meta:initialized";
const KEY_TOMBSTONE = "meta:tombstone";
const KEY_PENDING_VAULT_DELETED = "meta:pendingVaultDeleted";
const KEY_SCHEDULED_FOR = "meta:scheduledFor";
const TOKEN_PREFIX = "token:";
const DEVICE_PREFIX = "device:";
const EVENT_PREFIX = "event:";
const NONCE_PREFIX = "nonce:";
const SEQ_PAD_WIDTH = 16;

/**
 * Tolerance (ms) for `scheduledFor` in the past on `POST /schedule-deletion`.
 * Clients may have slightly fast clocks; rejecting anything in the past would
 * make a healthy client occasionally fail to schedule. 5 minutes is generous
 * enough to absorb realistic clock skew and small enough that a true replay
 * (a re-POST of a sniffed schedule from hours ago) still rejects.
 * Documented in `apps/relay/README.md` §"Vault deletion".
 */
const SCHEDULE_DELETION_SKEW_MS = 5 * 60 * 1000;

function eventKey(seq: number): string {
  return `${EVENT_PREFIX}${seq.toString().padStart(SEQ_PAD_WIDTH, "0")}`;
}

function nonceKey(deviceId: string, clientNonce: string): string {
  return `${NONCE_PREFIX}${deviceId}:${clientNonce}`;
}

function tokenKey(token: string): string {
  return `${TOKEN_PREFIX}${token}`;
}

function deviceKey(deviceId: string): string {
  return `${DEVICE_PREFIX}${deviceId}`;
}

/** Value persisted at `token:<token>`. Wraps the owning deviceId. */
interface TokenRecord {
  deviceId: string;
}

/**
 * Value persisted at `meta:tombstone` AFTER the deletion alarm has fired
 * (issue #30). The 410 dispatcher check only reads truthy/falsy from this
 * key — the structured shape exists so that GET-style introspection (tests,
 * future status endpoints) can surface "deleted at <time>, seq <n>" without
 * re-reading the wiped event log. Earlier code paths (and the test
 * affordance `setTombstone`) may write a bare `true`; both shapes are
 * accepted by `#isTombstoned`.
 */
interface TombstoneRecord {
  deletedAt: number;
  vaultDeletedSeq: number;
}

// Single source of truth for the per-DO page-size cap. Exposed via an
// optional `MAX_PAGE_SIZE_OVERRIDE` Env binding so tests can drive the
// "more events than fit in one page → nextSince is non-null" path without
// pushing a thousand-event fixture. Production callers do not set the
// override; the constant from `@defer/core/relay-protocol` applies.
function maxPageSize(env: Env): number {
  const override = env.MAX_PAGE_SIZE_OVERRIDE;
  if (override !== undefined && override !== "") {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return MAX_PAGE_SIZE;
}

export class VaultRelay {
  readonly #state: DurableObjectState;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    // Single dispatch point so every endpoint shares the tombstone short-
    // circuit and per-handler error normalisation. The Worker-side router
    // strips the `/v1/vault/:vaultId` prefix and rewrites the URL before
    // forwarding, so we match against the remaining path.
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

      // 410 short-circuit. ADR-0007 §2: a tombstoned vault returns
      // `VAULT_DELETED` on EVERY endpoint, and the check runs BEFORE auth
      // (ADR-0007 §1 + issue #30). A request to a dead vault with a junk
      // bearer must surface "the vault is gone" — that's a stronger,
      // more useful signal than "your bearer is bad", and it spares
      // tombstone-checking code in each handler.
      if (await this.#isTombstoned()) {
        throw new RelayError("VAULT_DELETED");
      }

      if (path === "/events" && method === "POST") {
        return await this.#handlePush(request);
      }
      if (path === "/events" && method === "GET") {
        return await this.#handlePull(request, url);
      }
      if (path === "/devices" && method === "POST") {
        return await this.#handleRegisterDevice(request);
      }
      // `/devices/:deviceId` — DELETE only (issue #27). The Worker URL-encodes
      // the deviceId so any odd byte survives; here we decode and validate
      // before touching storage.
      if (path.startsWith("/devices/") && method === "DELETE") {
        const rawId = path.slice("/devices/".length);
        return await this.#handleRevokeDevice(request, decodeURIComponent(rawId));
      }
      // Deletion control plane (issue #29). The data plane (alarm fire +
      // `VaultDeleted` emission) lives in #30.
      if (path === "/schedule-deletion" && method === "POST") {
        return await this.#handleScheduleDeletion(request);
      }
      if (path === "/cancel-deletion" && method === "POST") {
        return await this.#handleCancelDeletion(request);
      }

      // Anything else against an initialized DO is a router bug — the Worker
      // shouldn't have forwarded it. Treat as 404 UNKNOWN_VAULT for shape.
      throw new RelayError("UNKNOWN_VAULT", `no DO handler for ${method} ${path}`);
    } catch (err) {
      return this.#errorResponse(err);
    }
  }

  // --- alarm(): vault-deletion data plane ----------------------------------
  //
  // Fired by the Cloudflare runtime when the wall-clock time the control
  // plane (#29) armed via `state.storage.setAlarm(scheduledFor)` is reached.
  // Cloudflare guarantees at-least-once delivery; this handler is therefore
  // built to be idempotent.
  //
  // Order matters (ADR-0005, ADR-0006 §5, issue #30):
  //
  //   1. Tombstone-already? → no-op + structured "alarm.duplicate" log.
  //   2. Load `meta:pendingVaultDeleted`. If missing (cancel-then-fire race
  //      window), no-op + structured "alarm.no-pending-payload" log.
  //   3. Stamp `seq` on the pre-signed envelope, append to event log,
  //      register the nonce, advance `meta:nextSeq`.
  //   4. Snapshot `deletedAt` and the assigned seq into local variables
  //      BEFORE the deleteAll() — they have to survive storage wipe.
  //   5. `state.storage.deleteAll()` — wipes EVERYTHING including the keys
  //      we just wrote. ADR-0005 is explicit: the vault's encrypted blobs
  //      are gone from the relay after deletion.
  //   6. Re-write `meta:tombstone` as the very last storage operation. It
  //      survives step 5 because we write it AFTER. The tombstone is the
  //      source-of-truth for "this vault is dead" — the 410 dispatcher
  //      check at the top of `fetch()` reads it.
  //
  // The dance in steps 5–6 is the trick the issue body calls out: there is
  // no "deleteAll except for one key" primitive on DO storage, so we wipe
  // and immediately re-write the marker. DO single-threading guarantees no
  // concurrent request can observe the inter-step empty state.
  async alarm(): Promise<void> {
    // Step 1: idempotency. At-least-once alarm delivery means we might be
    // called for a vault that's already tombstoned. The vault's state cannot
    // change after this, so a repeat fire is a clean no-op.
    if (await this.#isTombstoned()) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ event: "alarm.duplicate", level: "debug" }));
      return;
    }

    // Step 2: load the pre-signed envelope. If a `POST /cancel-deletion`
    // sneaked in between alarm-set and alarm-fire (the cancel handler
    // deletes `meta:pendingVaultDeleted` and clears the alarm — but the
    // alarm may already be in-flight from the runtime), we have no envelope
    // to emit. The cancellation already accomplished the cancel; the alarm
    // is a leftover. Log and exit.
    const pending = await this.#state.storage.get<unknown>(KEY_PENDING_VAULT_DELETED);
    if (pending === undefined) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ event: "alarm.no-pending-payload", level: "debug" }));
      return;
    }

    // Step 3: stamp seq and write to the event log.
    const nextSeqStored = (await this.#state.storage.get<number>(KEY_NEXT_SEQ)) ?? 1;
    const assignedSeq = nextSeqStored;
    // Type narrowing: parse via the pending schema for type safety; the
    // control plane (#29) already validated this blob before storing, so
    // re-validation here is paranoia, not a meaningful guard. We use the
    // typed `PendingEvent` shape so `stampSeq` can return the discriminated
    // union `Event` cleanly.
    const stamped: Event = stampSeq(pending as PendingEvent, assignedSeq);
    // Per ADR-0006 §5, the MAC on the pre-signed envelope is computed over
    // the envelope WITHOUT `seq`, so adding `seq` here does not invalidate
    // the signature when clients verify it. The envelope is otherwise
    // byte-equal to what `POST /schedule-deletion` stored.
    const pendingDeleted = pending as PendingEvent;
    const relayNonceKey = nonceKey(pendingDeleted.deviceId, pendingDeleted.clientNonce);

    await this.#state.storage.put({
      [eventKey(assignedSeq)]: stamped,
      [relayNonceKey]: assignedSeq,
      [KEY_NEXT_SEQ]: nextSeqStored + 1,
    });

    // Step 4: snapshot the fields we need to re-write after `deleteAll`.
    // `stamped.data.deletedAt` is the canonical `deletedAt` from the
    // pre-signed payload (== `scheduledFor` per ADR-0006 §5's equality
    // rule, enforced at schedule-time).
    //
    // Type narrowing: `stamped` is the `Event` discriminated union. We
    // asserted at schedule-time that `pending.type === "VaultDeleted"`
    // (schema validation in `#handleScheduleDeletion`), so accessing
    // `.data.deletedAt` is safe. The cast keeps the type system aware
    // that this branch is `VaultDeleted` without re-doing the parse.
    const deletedAt = (stamped as Event & { type: "VaultDeleted" }).data.deletedAt;
    const vaultDeletedSeq = assignedSeq;

    // Step 5: wipe everything. After this returns, the DO has no events,
    // no tokens, no device list, no nonces, no scheduledFor, no
    // pendingVaultDeleted, no initialized marker, no nextSeq, no
    // tombstone — empty.
    await this.#state.storage.deleteAll();

    // Step 6: write the tombstone as a single-key put AFTER the wipe. The
    // structured shape carries `deletedAt` (for clients that want to
    // explain "this vault was deleted at <time>" without needing the
    // event log) and `vaultDeletedSeq` (the seq the alarm assigned to
    // the now-wiped event, for parity with the in-memory record some
    // tests assert against). The 410 dispatcher check only reads truthy/
    // falsy from this key, so the shape is informational.
    //
    // Single-threading note: between step 5 and step 6 the DO is briefly
    // empty (no tombstone yet). DO request handlers are serialised on the
    // same isolate as `alarm()`, so no incoming request can observe the
    // gap. Cloudflare's docs guarantee `alarm()` runs to completion
    // before the next request handler tick — see
    // https://developers.cloudflare.com/durable-objects/api/alarms/.
    const tombstone: TombstoneRecord = { deletedAt, vaultDeletedSeq };
    await this.#state.storage.put(KEY_TOMBSTONE, tombstone);
  }

  // --- POST /events --------------------------------------------------------

  async #handlePush(request: Request): Promise<Response> {
    // The fetch() dispatcher already short-circuited tombstoned vaults to
    // 410, so we don't repeat the check here.
    const token = requireBearerToken(request);
    const initialized = await this.#isInitialized();

    // Schema-validate first so a malformed body never touches storage, but
    // bootstrap-state check happens BEFORE auth-set lookup (we need to know
    // whether to self-register or to reject).
    const body = (await request.json().catch(() => {
      throw new RelayError("SCHEMA_VIOLATION", "request body is not valid JSON");
    })) as unknown;

    const parsed = PushEventsRequestSchema.safeParse(body);
    if (!parsed.success) {
      // ZodError reuses the SCHEMA_VIOLATION path; we throw the typed
      // RelayError so the catch-all formats it consistently.
      throw new RelayError("SCHEMA_VIOLATION", "request body failed schema validation");
    }

    if (initialized) {
      const known = await this.#state.storage.get<TokenRecord>(tokenKey(token));
      if (known === undefined) {
        throw new RelayError("INVALID_TOKEN");
      }
    }
    // else: first-write self-registration (ADR-0007 §1) — fall through; the
    // token is persisted as part of the same transaction below so a crash
    // mid-bootstrap can't leave events without an auth token. Issue #27
    // extends this path to also persist the first event's `deviceId` as the
    // owner of the bootstrap token, so subsequent DELETE /devices/:deviceId
    // calls can self-revoke the bootstrap device.

    const events = parsed.data.events;

    // Pre-flight: load nextSeq once, scan for duplicate `(deviceId, clientNonce)`
    // either against pre-existing storage or within the batch itself. The whole
    // batch aborts on the first duplicate (atomic). Storage stays untouched.
    const nextSeqStored = (await this.#state.storage.get<number>(KEY_NEXT_SEQ)) ?? 1;
    const seenInBatch = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const key = nonceKey(ev.deviceId, ev.clientNonce);
      if (seenInBatch.has(key)) {
        throw new RelayError(
          "DUPLICATE_CLIENT_NONCE",
          `duplicate (deviceId, clientNonce) at index ${i}`,
        ).withDetails({ eventIndex: i });
      }
      const existing = await this.#state.storage.get<number>(key);
      if (existing !== undefined) {
        throw new RelayError(
          "DUPLICATE_CLIENT_NONCE",
          `(deviceId, clientNonce) already accepted at index ${i}`,
        ).withDetails({ eventIndex: i });
      }
      seenInBatch.set(key, i);
    }

    // Assign seq + build the persisted shape. The full envelope is stored
    // (with `seq` stamped) so `GET /events` returns it verbatim. The pending
    // schema strips unknown keys, so we explicitly construct the inbound
    // shape rather than spread-and-pray.
    const assigned: number[] = [];
    const toPut: Record<string, unknown> = {};
    for (let i = 0; i < events.length; i++) {
      const pending = events[i]!;
      const seq = nextSeqStored + i;
      const stamped: Event = stampSeq(pending, seq);
      assigned.push(seq);
      toPut[eventKey(seq)] = stamped;
      toPut[nonceKey(pending.deviceId, pending.clientNonce)] = seq;
    }
    toPut[KEY_NEXT_SEQ] = nextSeqStored + events.length;
    if (!initialized) {
      toPut[KEY_INITIALIZED] = true;
      // Bootstrap-deviceId capture (issue #27). The first event's `deviceId`
      // becomes the owner of the bootstrap token. Subsequent events in the
      // same batch may carry other deviceIds — those do NOT auto-register;
      // they would need an explicit POST /devices to gain their own token.
      // The envelope schema requires `deviceId`, so `events[0]` always has
      // one — the `!` is safe because PushEventsRequestSchema enforces
      // `.min(1)` on the batch.
      const bootstrapDeviceId = events[0]!.deviceId;
      const tokenRecord: TokenRecord = { deviceId: bootstrapDeviceId };
      toPut[tokenKey(token)] = tokenRecord;
      toPut[deviceKey(bootstrapDeviceId)] = token;
    }

    // DO single-threadedness already serializes mutations; the put-many is the
    // belt-and-suspenders against partial writes on crash. `transaction()` is
    // overkill for a single multi-key put (DO storage applies these atomically
    // to disk anyway), but using put-many keeps the call minimal and consistent.
    await this.#state.storage.put(toPut);

    const responseBody: PushEventsResponse = { assigned };
    return this.#json(200, responseBody);
  }

  // --- GET /events ---------------------------------------------------------

  async #handlePull(request: Request, url: URL): Promise<Response> {
    // The fetch() dispatcher already short-circuited tombstoned vaults to
    // 410, so we don't repeat the check here.
    const token = requireBearerToken(request);

    // ADR-0007 §1: GET against an uninitialized vault returns 404 UNKNOWN_VAULT.
    // No first-write on GET — only POST /events bootstraps.
    const initialized = await this.#isInitialized();
    if (!initialized) {
      throw new RelayError("UNKNOWN_VAULT");
    }

    const known = await this.#state.storage.get<TokenRecord>(tokenKey(token));
    if (known === undefined) {
      throw new RelayError("INVALID_TOKEN");
    }

    // `?since=` defaults to 0; must be a non-negative integer.
    const sinceRaw = url.searchParams.get("since");
    let since = 0;
    if (sinceRaw !== null) {
      const n = Number(sinceRaw);
      if (!Number.isInteger(n) || n < 0) {
        throw new RelayError("SCHEMA_VIOLATION", "?since must be a non-negative integer");
      }
      since = n;
    }

    // Storage list with a key range. `start` is exclusive in semantics here:
    // events with seq > since means starting at seq = since + 1. `end` is
    // open (no upper bound) because the prefix is shared by all `event:` keys.
    // We cap at MAX_PAGE_SIZE + 1 to detect "more events exist past this page."
    const limit = maxPageSize(this.#env);
    const startKey = eventKey(since + 1);
    const listed = await this.#state.storage.list<Event>({
      prefix: EVENT_PREFIX,
      start: startKey,
      limit: limit + 1,
    });

    const ordered: Event[] = [];
    for (const value of listed.values()) {
      ordered.push(value);
    }
    // `storage.list()` returns keys in lexicographic order; the zero-padded
    // event keys are therefore in `seq` order. We do not re-sort.

    let nextSince: number | null = null;
    if (ordered.length > limit) {
      // Trim the lookahead row; `nextSince` is the last seq actually returned.
      ordered.length = limit;
      const last = ordered[ordered.length - 1]!;
      nextSince = last.seq;
    }

    const responseBody: PullEventsResponse = { events: ordered, nextSince };
    return this.#json(200, responseBody);
  }

  // --- POST /devices -------------------------------------------------------

  // Pairing-flow step 5 (PRD §"Pairing handshake"): an existing-device caller
  // sponsors a newly-paired device by adding its `deviceAuthToken` to the
  // per-vault valid-tokens set. The relay does not, and cannot, verify the
  // cryptographic link between the new token and the vault key — that's a
  // blind-relay invariant (ADR-0001). The caller's possession of a valid
  // bearer is the only auth signal.
  async #handleRegisterDevice(request: Request): Promise<Response> {
    // The fetch() dispatcher already short-circuited tombstoned vaults to
    // 410 BEFORE auth. ADR-0007 §2: a tombstoned vault never surfaces
    // "unknown vault" or "invalid token" — it's `gone`, full stop.
    const token = requireBearerToken(request);

    // No first-write self-registration on this endpoint (ADR-0007 §1 table):
    // an uninitialized vault is `UNKNOWN_VAULT`, not "bootstrap-on-POST".
    const initialized = await this.#isInitialized();
    if (!initialized) {
      throw new RelayError("UNKNOWN_VAULT");
    }

    const known = await this.#state.storage.get<TokenRecord>(tokenKey(token));
    if (known === undefined) {
      throw new RelayError("INVALID_TOKEN");
    }

    const body = (await request.json().catch(() => {
      throw new RelayError("SCHEMA_VIOLATION", "request body is not valid JSON");
    })) as unknown;
    const parsed = RegisterDeviceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new RelayError("SCHEMA_VIOLATION", "request body failed schema validation");
    }
    const { deviceId, deviceAuthToken } = parsed.data;

    // Duplicate-deviceId check (issue #27 spec): if `deviceId` already maps
    // to a token, reject with 409 DEVICE_ALREADY_REGISTERED. The details
    // object carries the offending id so clients can render a meaningful
    // error without re-parsing the request body.
    const existing = await this.#state.storage.get<string>(deviceKey(deviceId));
    if (existing !== undefined) {
      throw new RelayError(
        "DEVICE_ALREADY_REGISTERED",
        `deviceId already registered for this vault`,
      ).withDetails({ deviceId });
    }

    // Persist both directions in a single put-many so a crash mid-write can't
    // leave a half-registered device. DO storage applies the multi-key put
    // atomically to disk.
    const tokenRecord: TokenRecord = { deviceId };
    await this.#state.storage.put({
      [tokenKey(deviceAuthToken)]: tokenRecord,
      [deviceKey(deviceId)]: deviceAuthToken,
    });

    const responseBody: RegisterDeviceResponse = { ok: true };
    return this.#json(200, responseBody);
  }

  // --- DELETE /devices/:deviceId -------------------------------------------

  // "Remove this device" flow (PRD user story 24). Any valid token for the
  // vault may revoke any device — including the device being revoked itself
  // (self-revoke). Last-device revoke is allowed and intentional: the vault
  // becomes unreachable until pairing happens again from another device, but
  // pairing requires an existing token, so practically the vault is only
  // recoverable via the recovery mnemonic on a fresh device. The DO is NOT
  // destroyed here — only the deletion-alarm path (#30) tombstones storage.
  async #handleRevokeDevice(request: Request, deviceId: string): Promise<Response> {
    // The fetch() dispatcher already short-circuited tombstoned vaults to
    // 410 BEFORE auth.
    const token = requireBearerToken(request);

    const initialized = await this.#isInitialized();
    if (!initialized) {
      throw new RelayError("UNKNOWN_VAULT");
    }

    const known = await this.#state.storage.get<TokenRecord>(tokenKey(token));
    if (known === undefined) {
      throw new RelayError("INVALID_TOKEN");
    }

    const ownerToken = await this.#state.storage.get<string>(deviceKey(deviceId));
    if (ownerToken === undefined) {
      throw new RelayError("UNKNOWN_DEVICE", `deviceId not registered`).withDetails({ deviceId });
    }

    // Delete both keys in a single batched call — single-threadedness of the
    // DO already serializes mutations, but the multi-key delete is the
    // belt-and-suspenders against a partial-write crash. Subsequent requests
    // carrying `ownerToken` will fail the token-lookup on the next request
    // (whether GET /events, POST /events, POST /devices, etc.) with 401.
    await this.#state.storage.delete([tokenKey(ownerToken), deviceKey(deviceId)]);

    const responseBody: RevokeDeviceResponse = { ok: true };
    return this.#json(200, responseBody);
  }

  // --- POST /schedule-deletion --------------------------------------------

  // Control-plane arm: persist the signed `VaultDeletionScheduled` on the
  // event log, stow the pre-signed `VaultDeleted` blob in DO storage (ADR-0006
  // §5), and arm a DO alarm for `scheduledFor`. The alarm handler itself is a
  // no-op skeleton until issue #30 lands the data-plane wipe.
  async #handleScheduleDeletion(request: Request): Promise<Response> {
    // The fetch() dispatcher already short-circuited tombstoned vaults to
    // 410 BEFORE auth, per ADR-0007 §1.
    const token = requireBearerToken(request);

    // 404 on uninitialized vault — no first-write self-registration on this
    // endpoint (ADR-0007 §1 table).
    const initialized = await this.#isInitialized();
    if (!initialized) {
      throw new RelayError("UNKNOWN_VAULT");
    }

    const known = await this.#state.storage.get<TokenRecord>(tokenKey(token));
    if (known === undefined) {
      throw new RelayError("INVALID_TOKEN");
    }

    const body = (await request.json().catch(() => {
      throw new RelayError("SCHEMA_VIOLATION", "request body is not valid JSON");
    })) as unknown;
    const parsed = ScheduleDeletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new RelayError("SCHEMA_VIOLATION", "request body failed schema validation");
    }
    const { scheduled, deleted } = parsed.data;

    // ADR-0006 §5: `deletedAt` MUST equal `scheduledFor`. The relay enforces
    // this because the alarm re-emits `deleted` verbatim; if the two diverged
    // the client would display a `deletedAt` that the user never authorised.
    if (scheduled.data.scheduledFor !== deleted.data.deletedAt) {
      throw new RelayError(
        "SCHEMA_VIOLATION",
        "deleted.deletedAt must equal scheduled.scheduledFor",
      ).withDetails({ reason: "deletedAt_mismatch" });
    }

    // ADR-0006 §5: the pre-signed `VaultDeleted` envelope uses the
    // `RELAY_DEVICE_ID` sentinel because the alarm — not a paired device —
    // is what re-emits it. A non-sentinel `deviceId` here means the client
    // pre-signed a payload that would attribute the deletion to a real
    // device, which violates the convention.
    if (deleted.deviceId !== RELAY_DEVICE_ID) {
      throw new RelayError(
        "SCHEMA_VIOLATION",
        `deleted.deviceId must be the relay sentinel`,
      ).withDetails({ reason: "deleted_deviceId_not_relay" });
    }

    // Past-time check with a small tolerance for client clock skew. A schedule
    // posted with a scheduledFor older than (now - skew) is most likely a
    // replay of a sniffed earlier request and is rejected — even though the
    // signature on the envelope is genuine, re-arming with an old timestamp
    // would mean the alarm could fire immediately on a vault the user had no
    // intention of deleting right now.
    const now = Date.now();
    if (scheduled.data.scheduledFor <= now - SCHEDULE_DELETION_SKEW_MS) {
      throw new RelayError(
        "SCHEMA_VIOLATION",
        "scheduledFor is in the past (beyond clock-skew tolerance)",
      ).withDetails({ reason: "scheduled_in_past" });
    }

    // Already-scheduled check. ADR-0006 §5 allows reschedule only via
    // cancel-then-reschedule; back-to-back schedule without an intervening
    // cancel is 409 so a malicious replay can't silently overwrite the
    // pending blob.
    const existingScheduledFor = await this.#state.storage.get<number>(KEY_SCHEDULED_FOR);
    if (existingScheduledFor !== undefined) {
      throw new RelayError("DELETION_ALREADY_SCHEDULED");
    }

    // Append the `scheduled` envelope to the event log with the next seq.
    // We also register the envelope's `clientNonce` in the nonce keyspace so a
    // later malicious replay of the same envelope via `POST /events` would
    // 409 with `DUPLICATE_CLIENT_NONCE` — keeping the replay-protection
    // surface uniform across all event-log writers.
    const nextSeqStored = (await this.#state.storage.get<number>(KEY_NEXT_SEQ)) ?? 1;
    const scheduledNonceKey = nonceKey(scheduled.deviceId, scheduled.clientNonce);

    // Defence-in-depth: if the scheduling envelope's nonce happens to already
    // be in storage (e.g. a malicious replay that sneaked through `POST /events`
    // first), reject with 409. Cleaner than silently overwriting.
    const existingNonce = await this.#state.storage.get<number>(scheduledNonceKey);
    if (existingNonce !== undefined) {
      throw new RelayError(
        "DUPLICATE_CLIENT_NONCE",
        "scheduled envelope's (deviceId, clientNonce) already accepted",
      );
    }

    const scheduledSeq = nextSeqStored;
    const stamped: Event = stampSeq(scheduled, scheduledSeq);

    await this.#state.storage.put({
      [eventKey(scheduledSeq)]: stamped,
      [scheduledNonceKey]: scheduledSeq,
      [KEY_NEXT_SEQ]: nextSeqStored + 1,
      [KEY_PENDING_VAULT_DELETED]: deleted,
      [KEY_SCHEDULED_FOR]: scheduled.data.scheduledFor,
    });

    // Arm the DO alarm. The alarm handler is a no-op skeleton in this PR;
    // #30 wires it up to emit `VaultDeleted` and tombstone the DO.
    await this.#state.storage.setAlarm(scheduled.data.scheduledFor);

    const responseBody: ScheduleDeletionResponse = {
      scheduledFor: scheduled.data.scheduledFor,
      assignedSeq: scheduledSeq,
    };
    return this.#json(200, responseBody);
  }

  // --- POST /cancel-deletion ----------------------------------------------

  // Control-plane disarm: append the signed `VaultDeletionCancelled` to the
  // event log, drop the stored pre-signed `VaultDeleted` blob (ADR-0006 §5),
  // and cancel the DO alarm.
  async #handleCancelDeletion(request: Request): Promise<Response> {
    // The fetch() dispatcher already short-circuited tombstoned vaults to
    // 410 BEFORE auth.
    const token = requireBearerToken(request);

    const initialized = await this.#isInitialized();
    if (!initialized) {
      throw new RelayError("UNKNOWN_VAULT");
    }

    const known = await this.#state.storage.get<TokenRecord>(tokenKey(token));
    if (known === undefined) {
      throw new RelayError("INVALID_TOKEN");
    }

    const body = (await request.json().catch(() => {
      throw new RelayError("SCHEMA_VIOLATION", "request body is not valid JSON");
    })) as unknown;
    const parsed = CancelDeletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new RelayError("SCHEMA_VIOLATION", "request body failed schema validation");
    }
    const { cancelled } = parsed.data;

    // Nothing-to-cancel check. ADR-0007 §2 introduces NO_PENDING_DELETION as
    // a new 409 code for exactly this case — distinct from
    // DELETION_ALREADY_SCHEDULED so clients can tell the two state errors
    // apart in a unified retry policy.
    const existingPending = await this.#state.storage.get<unknown>(KEY_PENDING_VAULT_DELETED);
    if (existingPending === undefined) {
      throw new RelayError("NO_PENDING_DELETION");
    }

    const cancelledNonceKey = nonceKey(cancelled.deviceId, cancelled.clientNonce);
    const existingNonce = await this.#state.storage.get<number>(cancelledNonceKey);
    if (existingNonce !== undefined) {
      throw new RelayError(
        "DUPLICATE_CLIENT_NONCE",
        "cancelled envelope's (deviceId, clientNonce) already accepted",
      );
    }

    const nextSeqStored = (await this.#state.storage.get<number>(KEY_NEXT_SEQ)) ?? 1;
    const cancelledSeq = nextSeqStored;
    const stamped: Event = stampSeq(cancelled, cancelledSeq);

    // Multi-key write: append the cancelled event, update nextSeq, register
    // the nonce, and DELETE the pending-vault-deleted markers all in one go.
    // DO storage applies multi-key puts atomically; the `delete()` calls run
    // separately but the DO's single-threaded request loop means no other
    // request can observe a half-cancelled state.
    await this.#state.storage.put({
      [eventKey(cancelledSeq)]: stamped,
      [cancelledNonceKey]: cancelledSeq,
      [KEY_NEXT_SEQ]: nextSeqStored + 1,
    });
    await this.#state.storage.delete([KEY_PENDING_VAULT_DELETED, KEY_SCHEDULED_FOR]);
    await this.#state.storage.deleteAlarm();

    const responseBody: CancelDeletionResponse = { assignedSeq: cancelledSeq };
    return this.#json(200, responseBody);
  }

  // --- helpers -------------------------------------------------------------

  async #isInitialized(): Promise<boolean> {
    return (await this.#state.storage.get<boolean>(KEY_INITIALIZED)) === true;
  }

  async #isTombstoned(): Promise<boolean> {
    // Any truthy value at `meta:tombstone` means the vault is dead. Issue #30
    // writes a structured `{ deletedAt, vaultDeletedSeq }` record; earlier
    // code paths (and the #29-era test affordance `setTombstone`) write a
    // bare `true`. Both must short-circuit every endpoint to 410.
    const value = await this.#state.storage.get<unknown>(KEY_TOMBSTONE);
    return value !== undefined && value !== null && value !== false;
  }

  #json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Normalises errors thrown inside the DO into the ADR-0007 §2 envelope. The
  // outer Worker error-envelope middleware would also do this, but the DO
  // response travels through `stub.fetch()` opaquely — by serialising the
  // envelope here we keep the contract one-sided: the DO returns a real HTTP
  // response, the Worker forwards it verbatim. The Worker still adds the
  // requestId to its own log lines via the response status; the DO doesn't
  // know the requestId so the body carries a sentinel that the Worker
  // overrides at forward-time (see relay-api.ts).
  #errorResponse(err: unknown): Response {
    if (err instanceof RelayError) {
      const body: Record<string, unknown> = {
        error: err.category,
        code: err.code,
        // Sentinel — overwritten by the Worker forwarder so the response
        // carries the correct per-request id. The DO has no access to the
        // requestId middleware context, so we stamp a placeholder and rely
        // on the Worker to fix it up.
        requestId: "00000000-0000-7000-8000-000000000000",
      };
      if (err.details !== undefined) {
        body.details = err.details;
      }
      return new Response(JSON.stringify(body), {
        status: err.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Unexpected throw — surface as INTERNAL_ERROR with no details so the
    // Worker's error-envelope middleware can fix up the requestId. The Worker
    // also logs the underlying message at its tier.
    return new Response(
      JSON.stringify({
        error: "internal_error",
        code: "INTERNAL_ERROR",
        requestId: "00000000-0000-7000-8000-000000000000",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Exposes #env to the linter so it doesn't flag the field as unused while
  // we wait for the future endpoint slices (#27, #28, #29) to consume it.
  // The page-size override path also reads this field via `maxPageSize(env)`.
  get env(): Env {
    return this.#env;
  }
}

// Build the sequenced envelope from the pending one. Discriminated-union
// preservation: we keep the original `type` and `data` and add the relay-stamped
// `seq`. The `EventSchema.parse` at the end is paranoia — if a future event
// type adds required fields to the inbound shape we don't have on the pending
// side, this throws loud rather than silently storing a malformed envelope.
function stampSeq(pending: PendingEvent, seq: number): Event {
  const stamped = { ...pending, seq };
  return EventSchema.parse(stamped);
}
