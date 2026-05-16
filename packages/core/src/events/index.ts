import { z } from "zod";

import {
  ItemSavedSchema,
  ItemArchivedSchema,
  ItemUnarchivedSchema,
  ItemLikedSchema,
  ItemUnlikedSchema,
  ItemTaggedSchema,
  ItemUntaggedSchema,
  ItemTitleEditedSchema,
  ItemDeletedSchema,
} from "./item-events.js";
import { DeviceRegisteredSchema, DeviceRevokedSchema } from "./device-events.js";
import {
  VaultDeletionScheduledSchema,
  VaultDeletionCancelledSchema,
  VaultDeletedSchema,
} from "./vault-events.js";

export * from "./envelope.js";
export * from "./item-events.js";
export * from "./device-events.js";
export * from "./vault-events.js";

// The v1 event catalog. Adding a new event type is allowed (old clients
// silently skip unknown types per ADR-0002); renaming or removing existing
// types is forbidden.
export const EventSchema = z.discriminatedUnion("type", [
  ItemSavedSchema,
  ItemArchivedSchema,
  ItemUnarchivedSchema,
  ItemLikedSchema,
  ItemUnlikedSchema,
  ItemTaggedSchema,
  ItemUntaggedSchema,
  ItemTitleEditedSchema,
  ItemDeletedSchema,
  DeviceRegisteredSchema,
  DeviceRevokedSchema,
  VaultDeletionScheduledSchema,
  VaultDeletionCancelledSchema,
  VaultDeletedSchema,
]);

export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];
