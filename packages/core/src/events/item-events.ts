import { z } from "zod";
import { envelopeFields } from "./envelope.js";

// Forward-compat note: Adding optional fields is safe; renaming or removing
// is forbidden — use a new event type.
//
// Each event ships two schemas:
// - `XxxSchema` — inbound (sequenced) shape, has `seq` from the relay.
// - `PendingXxxSchema` — outbound (pre-relay) shape, no `seq` yet.
//
// Pending schemas are derived via `.omit({ seq: true })` so the two stay in
// lockstep automatically when fields are added.

export const ItemSavedSchema = z.object({
  type: z.literal("ItemSaved"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    // z.url() checks well-formedness at the schema boundary; canonicalization
    // (e.g. trailing-slash normalisation) is a separate concern and lives elsewhere.
    url: z.url(),
    canonicalUrl: z.url(),
    // Empty string is intentional: items can be saved before a title is extracted.
    title: z.string(),
    savedAt: z.number().int().nonnegative(),
  }),
});
export type ItemSaved = z.infer<typeof ItemSavedSchema>;
export const PendingItemSavedSchema = ItemSavedSchema.omit({ seq: true });
export type PendingItemSaved = z.infer<typeof PendingItemSavedSchema>;

export const ItemArchivedSchema = z.object({
  type: z.literal("ItemArchived"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemArchived = z.infer<typeof ItemArchivedSchema>;
export const PendingItemArchivedSchema = ItemArchivedSchema.omit({ seq: true });
export type PendingItemArchived = z.infer<typeof PendingItemArchivedSchema>;

export const ItemUnarchivedSchema = z.object({
  type: z.literal("ItemUnarchived"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemUnarchived = z.infer<typeof ItemUnarchivedSchema>;
export const PendingItemUnarchivedSchema = ItemUnarchivedSchema.omit({ seq: true });
export type PendingItemUnarchived = z.infer<typeof PendingItemUnarchivedSchema>;

export const ItemLikedSchema = z.object({
  type: z.literal("ItemLiked"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemLiked = z.infer<typeof ItemLikedSchema>;
export const PendingItemLikedSchema = ItemLikedSchema.omit({ seq: true });
export type PendingItemLiked = z.infer<typeof PendingItemLikedSchema>;

export const ItemUnlikedSchema = z.object({
  type: z.literal("ItemUnliked"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemUnliked = z.infer<typeof ItemUnlikedSchema>;
export const PendingItemUnlikedSchema = ItemUnlikedSchema.omit({ seq: true });
export type PendingItemUnliked = z.infer<typeof PendingItemUnlikedSchema>;

export const ItemTaggedSchema = z.object({
  type: z.literal("ItemTagged"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    tag: z.string().min(1),
  }),
});
export type ItemTagged = z.infer<typeof ItemTaggedSchema>;
export const PendingItemTaggedSchema = ItemTaggedSchema.omit({ seq: true });
export type PendingItemTagged = z.infer<typeof PendingItemTaggedSchema>;

export const ItemUntaggedSchema = z.object({
  type: z.literal("ItemUntagged"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    tag: z.string().min(1),
  }),
});
export type ItemUntagged = z.infer<typeof ItemUntaggedSchema>;
export const PendingItemUntaggedSchema = ItemUntaggedSchema.omit({ seq: true });
export type PendingItemUntagged = z.infer<typeof PendingItemUntaggedSchema>;

export const ItemTitleEditedSchema = z.object({
  type: z.literal("ItemTitleEdited"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    title: z.string(),
  }),
});
export type ItemTitleEdited = z.infer<typeof ItemTitleEditedSchema>;
export const PendingItemTitleEditedSchema = ItemTitleEditedSchema.omit({ seq: true });
export type PendingItemTitleEdited = z.infer<typeof PendingItemTitleEditedSchema>;

export const ItemDeletedSchema = z.object({
  type: z.literal("ItemDeleted"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemDeleted = z.infer<typeof ItemDeletedSchema>;
export const PendingItemDeletedSchema = ItemDeletedSchema.omit({ seq: true });
export type PendingItemDeleted = z.infer<typeof PendingItemDeletedSchema>;
