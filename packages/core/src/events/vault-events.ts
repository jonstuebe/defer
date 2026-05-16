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
export const VaultDeletionScheduledSchema = z.object({
  type: z.literal("VaultDeletionScheduled"),
  ...envelopeFields,
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
  data: z.object({
    deletedAt: z.number().int().nonnegative(),
  }),
});
export type VaultDeleted = z.infer<typeof VaultDeletedSchema>;
export const PendingVaultDeletedSchema = VaultDeletedSchema.omit({ seq: true });
export type PendingVaultDeleted = z.infer<typeof PendingVaultDeletedSchema>;
