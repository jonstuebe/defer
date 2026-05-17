import { z } from "zod";

import { EventSchema, PendingEventSchema } from "../events/index.js";

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
