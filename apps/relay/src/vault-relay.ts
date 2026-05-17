import type { DurableObjectState } from "@cloudflare/workers-types";
import { type Event, EventSchema, type PendingEvent } from "@defer/core";
import {
  MAX_PAGE_SIZE,
  PushEventsRequestSchema,
  RegisterDeviceRequestSchema,
  type PushEventsResponse,
  type PullEventsResponse,
  type RegisterDeviceResponse,
  type RevokeDeviceResponse,
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
//   meta:tombstone         true            — set by the deletion alarm (#30); checked
//                                            by every endpoint; permanent (no rebirth)
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
//
// `deviceId` is base64url per the envelope schema (no `:` collision risk); the
// composite key is therefore safe to delimit with `:`.

const KEY_NEXT_SEQ = "meta:nextSeq";
const KEY_INITIALIZED = "meta:initialized";
const KEY_TOMBSTONE = "meta:tombstone";
const TOKEN_PREFIX = "token:";
const DEVICE_PREFIX = "device:";
const EVENT_PREFIX = "event:";
const NONCE_PREFIX = "nonce:";
const SEQ_PAD_WIDTH = 16;

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
    // Single dispatch point so both endpoints share auth + tombstone checks
    // when applicable. The Worker-side router strips the `/v1/vault/:vaultId`
    // prefix and rewrites the URL before forwarding, so we match against the
    // remaining path.
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

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

      // Anything else against an initialized DO is a router bug — the Worker
      // shouldn't have forwarded it. Treat as 404 UNKNOWN_VAULT for shape.
      throw new RelayError("UNKNOWN_VAULT", `no DO handler for ${method} ${path}`);
    } catch (err) {
      return this.#errorResponse(err);
    }
  }

  async alarm(): Promise<void> {
    // No-op skeleton. The deletion alarm (ADR-0005, ADR-0006 §5) lands with
    // issue #30.
  }

  // --- POST /events --------------------------------------------------------

  async #handlePush(request: Request): Promise<Response> {
    const token = requireBearerToken(request);
    const initialized = await this.#isInitialized();
    const tombstoned = await this.#isTombstoned();
    if (tombstoned) {
      throw new RelayError("VAULT_DELETED");
    }

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
    const token = requireBearerToken(request);

    // ADR-0007 §1: GET against an uninitialized vault returns 404 UNKNOWN_VAULT.
    // No first-write on GET — only POST /events bootstraps.
    const initialized = await this.#isInitialized();
    if (!initialized) {
      throw new RelayError("UNKNOWN_VAULT");
    }

    const tombstoned = await this.#isTombstoned();
    if (tombstoned) {
      throw new RelayError("VAULT_DELETED");
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
    const token = requireBearerToken(request);

    // Tombstone check is unconditional and runs before unknown-vault check
    // for symmetry with the events endpoints. A tombstoned vault never
    // surfaces "unknown vault" — it's `gone`, full stop (ADR-0007 §2).
    const tombstoned = await this.#isTombstoned();
    if (tombstoned) {
      throw new RelayError("VAULT_DELETED");
    }

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
    const token = requireBearerToken(request);

    const tombstoned = await this.#isTombstoned();
    if (tombstoned) {
      throw new RelayError("VAULT_DELETED");
    }

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

  // --- helpers -------------------------------------------------------------

  async #isInitialized(): Promise<boolean> {
    return (await this.#state.storage.get<boolean>(KEY_INITIALIZED)) === true;
  }

  async #isTombstoned(): Promise<boolean> {
    return (await this.#state.storage.get<boolean>(KEY_TOMBSTONE)) === true;
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
