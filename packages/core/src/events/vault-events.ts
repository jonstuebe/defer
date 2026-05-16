import { z } from "zod";
import { envelopeFields } from "./envelope.js";

// Forward-compat note: Adding optional fields is safe; renaming or removing
// is forbidden — use a new event type.

export const VaultDeletionScheduledSchema = z.object({
  type: z.literal("VaultDeletionScheduled"),
  ...envelopeFields,
  data: z.object({
    scheduledFor: z.number().int().nonnegative(),
    scheduledBy: z.string().min(1),
  }),
});
export type VaultDeletionScheduled = z.infer<typeof VaultDeletionScheduledSchema>;

export const VaultDeletionCancelledSchema = z.object({
  type: z.literal("VaultDeletionCancelled"),
  ...envelopeFields,
  data: z.object({
    cancelledBy: z.string().min(1),
  }),
});
export type VaultDeletionCancelled = z.infer<typeof VaultDeletionCancelledSchema>;

export const VaultDeletedSchema = z.object({
  type: z.literal("VaultDeleted"),
  ...envelopeFields,
  data: z.object({
    deletedAt: z.number().int().nonnegative(),
  }),
});
export type VaultDeleted = z.infer<typeof VaultDeletedSchema>;
