import { z } from "zod";
import { envelopeFields } from "./envelope.js";

// Forward-compat note: Adding optional fields is safe; renaming or removing
// is forbidden — use a new event type.

export const ItemSavedSchema = z.object({
  type: z.literal("ItemSaved"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    url: z.string().min(1),
    canonicalUrl: z.string().min(1),
    title: z.string(),
    savedAt: z.number().int().nonnegative(),
  }),
});
export type ItemSaved = z.infer<typeof ItemSavedSchema>;

export const ItemArchivedSchema = z.object({
  type: z.literal("ItemArchived"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemArchived = z.infer<typeof ItemArchivedSchema>;

export const ItemUnarchivedSchema = z.object({
  type: z.literal("ItemUnarchived"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemUnarchived = z.infer<typeof ItemUnarchivedSchema>;

export const ItemLikedSchema = z.object({
  type: z.literal("ItemLiked"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemLiked = z.infer<typeof ItemLikedSchema>;

export const ItemUnlikedSchema = z.object({
  type: z.literal("ItemUnliked"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemUnliked = z.infer<typeof ItemUnlikedSchema>;

export const ItemTaggedSchema = z.object({
  type: z.literal("ItemTagged"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    tag: z.string().min(1),
  }),
});
export type ItemTagged = z.infer<typeof ItemTaggedSchema>;

export const ItemUntaggedSchema = z.object({
  type: z.literal("ItemUntagged"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    tag: z.string().min(1),
  }),
});
export type ItemUntagged = z.infer<typeof ItemUntaggedSchema>;

export const ItemTitleEditedSchema = z.object({
  type: z.literal("ItemTitleEdited"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
    title: z.string(),
  }),
});
export type ItemTitleEdited = z.infer<typeof ItemTitleEditedSchema>;

export const ItemDeletedSchema = z.object({
  type: z.literal("ItemDeleted"),
  ...envelopeFields,
  data: z.object({
    itemId: z.string().min(1),
  }),
});
export type ItemDeleted = z.infer<typeof ItemDeletedSchema>;
