import { z } from "zod";
import { envelopeFields } from "./envelope.js";

// Forward-compat note: Adding optional fields is safe; renaming or removing
// is forbidden — use a new event type.
//
// Each event ships two schemas — see `item-events.ts` for the rationale.

// Design note: the envelope's `deviceId` already identifies which paired
// device emitted the event, so prior drafts of these schemas that carried
// `scheduledBy` / `cancelledBy` in `data` were duplicating envelope info.
// ADR-0005 says "any paired device can emit" both events — the relevant
// "who" is the emitting device, already in the envelope. UX that wants to
// show a device *name* ("scheduled by Jon's iPhone") resolves it from the
// local Device registry built from `DeviceRegistered` events, not from a
// per-event payload field. The fields have been dropped pre-shipping; see
// ADR-0002 on the immutability rule, which applies once events are on the
// wire.

// Vault-key-MAC'd events.
//
// CONTEXT.md describes VaultDeletionScheduled, VaultDeletionCancelled, and
// VaultDeleted as "signed with the Vault key" — shorthand for HMAC-SHA256
// under the symmetric vault key (see CONTEXT.md's glossary note on the
// Vault key). For VaultDeleted in particular: "clients verify the signature
// against the vault key before wiping". The `signature` field below carries
// that MAC on the wire.
//
// Wire format (ADR-0006):
//   - HMAC-SHA256 output is 32 bytes, encoded as base64url without padding.
//   - That's exactly 43 characters from the alphabet [A-Za-z0-9_-].
//   - The schema's job is wire-format validation, not crypto verification.
//     Recomputing the MAC over the canonical bytes is the consumer's job
//     (the `crypto` module in packages/core/src/crypto/signatures.ts).
//
// What the MAC covers (ADR-0006):
//   - JCS (RFC 8785) canonicalization of the envelope JSON with the
//     `signature` field removed AND the `seq` field removed. Clients sign
//     before the relay assigns `seq`, so `seq` cannot be part of the signed
//     bytes; verifiers must strip `seq` again before recomputing the MAC.

// 32-byte HMAC-SHA256 output → 43 base64url chars unpadded.
const SIGNATURE_REGEX = /^[A-Za-z0-9_-]{43}$/;

const signatureField = {
  signature: z.string().regex(SIGNATURE_REGEX, {
    message: "signature must be base64url-encoded HMAC-SHA256 (43 chars, no padding)",
  }),
};

export const VaultDeletionScheduledSchema = z.object({
  type: z.literal("VaultDeletionScheduled"),
  ...envelopeFields,
  ...signatureField,
  data: z.object({
    scheduledFor: z.number().int().nonnegative(),
  }),
});
export type VaultDeletionScheduled = z.infer<typeof VaultDeletionScheduledSchema>;
export const PendingVaultDeletionScheduledSchema = VaultDeletionScheduledSchema.omit({ seq: true });
export type PendingVaultDeletionScheduled = z.infer<typeof PendingVaultDeletionScheduledSchema>;

export const VaultDeletionCancelledSchema = z.object({
  type: z.literal("VaultDeletionCancelled"),
  ...envelopeFields,
  ...signatureField,
  data: z.object({}),
});
export type VaultDeletionCancelled = z.infer<typeof VaultDeletionCancelledSchema>;
export const PendingVaultDeletionCancelledSchema = VaultDeletionCancelledSchema.omit({ seq: true });
export type PendingVaultDeletionCancelled = z.infer<typeof PendingVaultDeletionCancelledSchema>;

// `VaultDeleted` is the only event in the v1 catalog emitted by the Relay
// rather than a paired device — specifically, by the vault's Durable Object
// alarm when the 48-hour deletion window elapses (see CONTEXT.md and
// ADR-0002). The Relay has no `deviceId`, so it stamps the envelope with the
// reserved `RELAY_DEVICE_ID` sentinel from `envelope.ts`. Schema-wise this is
// just a string — the sentinel's meaning is a convention enforced by:
//   1. the Relay always using `RELAY_DEVICE_ID` here,
//   2. clients verifying the vault-key signature before acting on
//      `VaultDeleted` (so a forged event from a real device with
//      `deviceId === "relay"` still can't trigger a wipe).
export const VaultDeletedSchema = z.object({
  type: z.literal("VaultDeleted"),
  ...envelopeFields,
  ...signatureField,
  data: z.object({
    deletedAt: z.number().int().nonnegative(),
  }),
});
export type VaultDeleted = z.infer<typeof VaultDeletedSchema>;
export const PendingVaultDeletedSchema = VaultDeletedSchema.omit({ seq: true });
export type PendingVaultDeleted = z.infer<typeof PendingVaultDeletedSchema>;
