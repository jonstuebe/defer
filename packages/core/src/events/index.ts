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
  PendingItemSavedSchema,
  PendingItemArchivedSchema,
  PendingItemUnarchivedSchema,
  PendingItemLikedSchema,
  PendingItemUnlikedSchema,
  PendingItemTaggedSchema,
  PendingItemUntaggedSchema,
  PendingItemTitleEditedSchema,
  PendingItemDeletedSchema,
} from "./item-events.js";
import {
  DeviceRegisteredSchema,
  DeviceRevokedSchema,
  PendingDeviceRegisteredSchema,
  PendingDeviceRevokedSchema,
} from "./device-events.js";
import {
  VaultDeletionScheduledSchema,
  VaultDeletionCancelledSchema,
  VaultDeletedSchema,
  PendingVaultDeletionScheduledSchema,
  PendingVaultDeletionCancelledSchema,
  PendingVaultDeletedSchema,
} from "./vault-events.js";

// `./envelope.js` is intentionally NOT re-exported via `export *`. Its
// `envelopeFields` and `pendingEnvelopeFields` values are internal authoring
// helpers for per-event schemas and must not leak into the package's public
// API — consumers building their own envelope-shaped schemas would silently
// diverge from this source of truth. The public `RELAY_DEVICE_ID` constant
// is re-exported explicitly below.
export { RELAY_DEVICE_ID } from "./envelope.js";
export * from "./item-events.js";
export * from "./device-events.js";
export * from "./vault-events.js";

// The v1 event catalog — inbound (sequenced) shape. Use this for anything
// downstream of the relay: sync, log replay, reducer input. Adding a new
// event type is allowed (old clients silently skip unknown types per
// ADR-0002); renaming or removing existing types is forbidden.
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

// The v1 event catalog — outbound (pre-relay) shape. Use this for the local
// pending-event queue and `relayClient.post(...)` payloads, where the relay
// has not yet assigned `seq`. Per ADR-0002 the relay stamps `seq` on arrival,
// so clients never construct it themselves.
//
// Note: Zod strips unknown keys by default, so a fully-sequenced `Event`
// handed to `PendingEventSchema` will parse successfully (the `seq` is
// silently dropped). This is intentional — the pending schema is permissive
// about extra keys, matching the forward-compat policy for envelope fields.
export const PendingEventSchema = z.discriminatedUnion("type", [
  PendingItemSavedSchema,
  PendingItemArchivedSchema,
  PendingItemUnarchivedSchema,
  PendingItemLikedSchema,
  PendingItemUnlikedSchema,
  PendingItemTaggedSchema,
  PendingItemUntaggedSchema,
  PendingItemTitleEditedSchema,
  PendingItemDeletedSchema,
  PendingDeviceRegisteredSchema,
  PendingDeviceRevokedSchema,
  PendingVaultDeletionScheduledSchema,
  PendingVaultDeletionCancelledSchema,
  PendingVaultDeletedSchema,
]);

export type PendingEvent = z.infer<typeof PendingEventSchema>;
export type PendingEventType = PendingEvent["type"];
