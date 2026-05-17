import { z } from "zod";

// `envelopeFields` and `pendingEnvelopeFields` below are internal authoring
// helpers used by sibling event-schema modules to spread the shared envelope
// fields. They are intentionally NOT re-exported from `./index.ts` — exposing
// them would let consumers build envelope-shaped schemas that silently diverge
// from this source of truth. `RELAY_DEVICE_ID` is part of the public API and
// IS re-exported explicitly from the barrel.

// Forward-compat note: Adding optional fields is safe; renaming or removing
// is forbidden — use a new event type.

/**
 * Reserved sentinel `deviceId` for events emitted by the Relay rather than a
 * paired device. The Relay has no `deviceId` of its own — it's a transport,
 * not a participant — so events it originates (today only `VaultDeleted`, see
 * `vault-events.ts` and CONTEXT.md) use this constant in the envelope's
 * `deviceId` slot.
 *
 * Canonical value: any Relay implementation MUST use exactly this string when
 * emitting an event. Clients MAY treat `deviceId === RELAY_DEVICE_ID` as the
 * marker for relay-originated events (currently `VaultDeleted` only). The
 * value is intentionally a short, human-readable string rather than a UUID so
 * it's obvious in logs and never collides with the 16-byte random device IDs
 * real devices generate.
 *
 * The envelope schema still validates this as just a non-empty string, so a
 * regular device using `"relay"` as its id would also pass schema validation;
 * the sentinel's meaning is enforced by convention and by the signature check
 * on `VaultDeleted` (verified against the vault key, not a device key).
 */
export const RELAY_DEVICE_ID = "relay";

// `clientNonce` on the wire: 16 random bytes, base64url-encoded without padding
// (22 chars). Pinned by ADR-0006 §4.1. The same value is fed in raw form into
// the AEAD AAD (`vaultId || deviceId || clientNonce`) so the relay cannot swap
// ciphertext blobs across events. The relay enforces uniqueness of
// `(deviceId, clientNonce)` per vault (ADR-0006 §4.2 — implemented in the
// events-push endpoint, not in this scaffold).
const CLIENT_NONCE_REGEX = /^[A-Za-z0-9_-]{22}$/;

const clientNonceField = {
  clientNonce: z.string().regex(CLIENT_NONCE_REGEX, {
    message: "clientNonce must be 16 random bytes base64url-encoded (22 chars, no padding)",
  }),
};

// Pending (outbound) envelope: the shape clients emit before the relay has
// assigned a `seq`. Per ADR-0002, the relay assigns a monotonic `seq` per
// vault on arrival, so locally queued events and `relayClient.post(...)`
// payloads have no `seq` yet. Per ADR-0006 §4.1 the envelope carries a
// client-chosen 16-byte `clientNonce` (cleartext) that the AEAD AAD binds to.
export const pendingEnvelopeFields = {
  deviceId: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  ...clientNonceField,
};

// Inbound (sequenced) envelope: the shape returned by the relay, with the
// assigned `seq`. Use this for anything downstream of the relay (sync, log
// replay, reducer input).
export const envelopeFields = {
  seq: z.number().int().nonnegative(),
  ...pendingEnvelopeFields,
};
