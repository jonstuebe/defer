import { z } from "zod";

import { EventSchema, PendingEventSchema } from "../events/index.js";
import {
  PendingVaultDeletionScheduledSchema,
  PendingVaultDeletionCancelledSchema,
  PendingVaultDeletedSchema,
} from "../events/vault-events.js";

// Wire shapes for the relay's event-log endpoints. The body of
// `POST /v1/vault/:vaultId/events` and the body returned by
// `GET /v1/vault/:vaultId/events?since=<seq>`. Schemas live here (not in the
// relay app) because both client and relay validate against them — keeping
// the schemas in `@defer/core` is the single source of truth that prevents
// drift between the two halves of the protocol.
//
// Forward-compat note: changing the request/response shape requires a
// protocol bump. Adding optional response fields (e.g. a future `cursor`
// alongside `nextSince`) is safe; renaming or removing existing fields is
// forbidden.

/**
 * Maximum number of events in a single `POST /events` batch. Pinned here so
 * both client and relay agree on the limit. Oversized batches are rejected
 * with `422 SCHEMA_VIOLATION` (the request body fails this schema's
 * `.max(MAX_BATCH_SIZE)` check).
 */
export const MAX_BATCH_SIZE = 100;

/**
 * Maximum number of events returned by a single `GET /events` response. The
 * relay caps each page at this value; if more events exist past the cap, the
 * response carries a non-null `nextSince` equal to the last `seq` returned
 * and the client SHOULD re-issue the GET with `?since=<nextSince>`. v1 does
 * not use opaque cursors — the `seq` itself is the cursor.
 */
export const MAX_PAGE_SIZE = 1000;

/**
 * Body shape for `POST /v1/vault/:vaultId/events`. The relay assigns `seq`
 * on arrival, so the request carries pending (pre-`seq`) envelopes. Batch is
 * non-empty and capped at `MAX_BATCH_SIZE`; oversized or empty batches fail
 * schema validation.
 */
export const PushEventsRequestSchema = z.object({
  events: z.array(PendingEventSchema).min(1).max(MAX_BATCH_SIZE),
});
export type PushEventsRequest = z.infer<typeof PushEventsRequestSchema>;

/**
 * Response shape for `POST /v1/vault/:vaultId/events`. `assigned[i]` is the
 * relay-assigned `seq` for `request.events[i]`. Same order as input. The
 * relay does NOT echo the full sequenced envelopes — clients GET them back
 * if they need the post-`seq` shape (typically they don't, since the local
 * pending-event queue retires entries by `clientNonce`).
 */
export const PushEventsResponseSchema = z.object({
  assigned: z.array(z.number().int().nonnegative()),
});
export type PushEventsResponse = z.infer<typeof PushEventsResponseSchema>;

/**
 * Response shape for `GET /v1/vault/:vaultId/events?since=<seq>`. `events`
 * is `seq`-ascending. `nextSince` is non-null iff the response was capped at
 * `MAX_PAGE_SIZE` and more events likely exist; the value is the last `seq`
 * returned so the client can resume with `?since=<nextSince>`.
 */
export const PullEventsResponseSchema = z.object({
  events: z.array(EventSchema),
  nextSince: z.number().int().nonnegative().nullable(),
});
export type PullEventsResponse = z.infer<typeof PullEventsResponseSchema>;

// --- Device-list management (issue #27) ----------------------------------
//
// Per-vault device-auth-token registration and revocation. `deviceId` and
// `deviceAuthToken` are both 16-byte random values rendered as 22-char
// base64url, matching the envelope `deviceId` format (ADR-0006 §4.1) and the
// bearer-token format used elsewhere. The closed regex is enforced both at
// the client (so a malformed token never leaves the device) and at the relay
// (so a malformed token never touches DO storage).

/** 22-char base64url — 16 bytes encoded with the URL-safe alphabet. */
const DEVICE_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;

/**
 * Body shape for `POST /v1/vault/:vaultId/devices`. Registers a new device's
 * `deviceAuthToken` for this vault. The bearer on the request must be an
 * existing valid token for the vault (pairing flow: the already-paired
 * device sponsors the new one).
 */
export const RegisterDeviceRequestSchema = z
  .object({
    deviceId: z.string().regex(DEVICE_ID_REGEX),
    deviceAuthToken: z.string().regex(DEVICE_ID_REGEX),
  })
  .strict();
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

/**
 * Response shape for `POST /v1/vault/:vaultId/devices`. The relay does not
 * echo back any state — the request body already carries everything the
 * client needs. `{ ok: true }` is a sentinel so the response is shape-checked
 * at the client boundary like every other relay response.
 */
export const RegisterDeviceResponseSchema = z.object({ ok: z.literal(true) });
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>;

/**
 * Response shape for `DELETE /v1/vault/:vaultId/devices/:deviceId`. Mirrors
 * `RegisterDeviceResponseSchema` — same `{ ok: true }` sentinel.
 */
export const RevokeDeviceResponseSchema = z.object({ ok: z.literal(true) });
export type RevokeDeviceResponse = z.infer<typeof RevokeDeviceResponseSchema>;

// --- Pairing handshake (issue #28) ---------------------------------------
//
// The pairing flow lets a new device receive a sealed `(vaultKey,
// deviceAuthToken)` blob from an already-paired device via the relay's
// blind-relay KV store. ADR-0003 §"pairing handshake" covers the cryptographic
// shape; this slice is the relay's wire contract. Both endpoints are
// unauthenticated — the unguessable 16-byte pairing token is the only access
// signal, and the relay never sees plaintext (the payload is sealed to the
// new device's ephemeral pubkey, which the relay never holds).
//
// Forward-compat note: extending the wire shape (e.g. adding optional response
// fields) is safe; renaming or removing existing fields requires a protocol
// bump.

/**
 * Closed regex for the pairing token on the wire. 16 bytes of CSPRNG encoded
 * as 22-char base64url (URL-safe alphabet, no padding) — the same shape used
 * for `vaultId`, `deviceId`, and `clientNonce` elsewhere in the protocol.
 * Enforced at both the client (so a malformed token never leaves the device)
 * and the relay (so a malformed token never touches KV).
 */
export const PAIRING_TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/;

/**
 * Hard cap on the decoded payload size in bytes. A sealed `(vaultKey,
 * deviceAuthToken)` is < 100 bytes in practice; 4 KB is a generous ceiling
 * that still rules out any abuse of the unauthenticated PUT endpoint as a
 * blob store. Decoded byte length is the real gate — the Zod regex only
 * confirms the wire charset.
 */
export const MAX_SEALED_PAYLOAD_BYTES = 4096;

/**
 * Body shape for `POST /v1/pairing`. The relay treats `sealedPayload` as
 * opaque bytes — the only schema-level constraint is that it's standard
 * base64 (URL-safe variants are NOT used here because the relay round-trips
 * the exact wire string; pinning the charset prevents a client from sneaking
 * non-base64 bytes in). Decoded-byte-length is enforced server-side after
 * Zod parse: payloads larger than `MAX_SEALED_PAYLOAD_BYTES` decoded → 422.
 *
 * No `PutPairingResponseSchema` is exported — the response is 204 No Content
 * (no body to parse).
 */
export const PutPairingRequestSchema = z
  .object({
    pairingToken: z.string().regex(PAIRING_TOKEN_REGEX),
    sealedPayload: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type PutPairingRequest = z.infer<typeof PutPairingRequestSchema>;

/**
 * Response shape for `GET /v1/pairing/:token`. The relay returns the exact
 * base64 string that was stored — clients decode + unseal locally. Same
 * base64 charset as `PutPairingRequestSchema.sealedPayload` so the round-trip
 * is byte-for-byte identical.
 */
export const GetPairingResponseSchema = z
  .object({
    sealedPayload: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type GetPairingResponse = z.infer<typeof GetPairingResponseSchema>;

// --- Vault deletion control plane (issue #29) ----------------------------
//
// The 48-hour delete-vault countdown is armed by `POST /schedule-deletion`
// and disarmed by `POST /cancel-deletion`. Both endpoints carry signed
// envelopes (vault-key HMAC, see ADR-0006 §2) that the relay persists +
// re-emits on the event log; the relay does NOT verify the MACs (it cannot
// — blind-relay invariant, ADR-0001). The data plane (alarm fire,
// `VaultDeleted` emission, `state.storage.deleteAll()` tombstone) lives in
// issue #30; here we only cover the control plane (arm / disarm + event-log
// append + DO alarm bookkeeping).
//
// `schedule-deletion` carries BOTH the `VaultDeletionScheduled` envelope
// (signed by the scheduling device) AND the pre-signed `VaultDeleted`
// envelope (signed by the same device, with `deviceId == RELAY_DEVICE_ID`
// and `deletedAt == scheduledFor`, per ADR-0006 §5). The relay persists
// `scheduled` on the event log immediately and stows `deleted` in DO
// storage for the alarm to re-emit verbatim when the window elapses.

/**
 * Body shape for `POST /v1/vault/:vaultId/schedule-deletion`. Both envelopes
 * are pre-`seq` (the relay assigns `seq` to `scheduled` on arrival; `deleted`
 * gets its `seq` when the alarm fires in #30). The cross-field equality
 * `scheduled.data.scheduledFor === deleted.data.deletedAt` and the
 * `deleted.deviceId === RELAY_DEVICE_ID` constraints from ADR-0006 §5 are
 * enforced server-side (post-Zod) — both produce `422 SCHEMA_VIOLATION`
 * with a `details.reason` string.
 */
export const ScheduleDeletionRequestSchema = z.object({
  scheduled: PendingVaultDeletionScheduledSchema,
  deleted: PendingVaultDeletedSchema,
});
export type ScheduleDeletionRequest = z.infer<typeof ScheduleDeletionRequestSchema>;

/**
 * Response shape for `POST /v1/vault/:vaultId/schedule-deletion`. Echoes the
 * `scheduledFor` so clients displaying the cross-device banner have it without
 * re-parsing the request body, and returns the `seq` the relay assigned to
 * the `scheduled` envelope (the only one that gets a `seq` at schedule time;
 * the pre-signed `deleted` is held in DO storage until the alarm fires).
 */
export const ScheduleDeletionResponseSchema = z.object({
  scheduledFor: z.number().int().nonnegative(),
  assignedSeq: z.number().int().positive(),
});
export type ScheduleDeletionResponse = z.infer<typeof ScheduleDeletionResponseSchema>;

/**
 * Body shape for `POST /v1/vault/:vaultId/cancel-deletion`. Carries the
 * signed `VaultDeletionCancelled` envelope; the relay deletes the stored
 * pre-signed `VaultDeleted` blob (ADR-0006 §5 mandates this), cancels the
 * DO alarm, and appends `cancelled` to the event log.
 */
export const CancelDeletionRequestSchema = z.object({
  cancelled: PendingVaultDeletionCancelledSchema,
});
export type CancelDeletionRequest = z.infer<typeof CancelDeletionRequestSchema>;

/**
 * Response shape for `POST /v1/vault/:vaultId/cancel-deletion`. Returns the
 * `seq` assigned to the `cancelled` envelope.
 */
export const CancelDeletionResponseSchema = z.object({
  assignedSeq: z.number().int().positive(),
});
export type CancelDeletionResponse = z.infer<typeof CancelDeletionResponseSchema>;
