import type { Event } from "../events/index.js";
import { initialVaultState, type VaultState } from "./state.js";
import {
  applyItemSaved,
  applyItemArchived,
  applyItemUnarchived,
  applyItemLiked,
  applyItemUnliked,
  applyItemTagged,
  applyItemUntagged,
  applyItemTitleEdited,
  applyItemDeleted,
} from "./item-reducers.js";
import { applyDeviceRegistered, applyDeviceRevoked } from "./device-reducers.js";
import {
  applyVaultDeletionScheduled,
  applyVaultDeletionCancelled,
  applyVaultDeleted,
} from "./vault-reducers.js";

export function apply(state: VaultState, event: Event): VaultState {
  // Kill switch: once the vault is deleted, every subsequent event is a no-op.
  if (state.isDeleted) return state;

  switch (event.type) {
    case "ItemSaved":
      return applyItemSaved(state, event);
    case "ItemArchived":
      return applyItemArchived(state, event);
    case "ItemUnarchived":
      return applyItemUnarchived(state, event);
    case "ItemLiked":
      return applyItemLiked(state, event);
    case "ItemUnliked":
      return applyItemUnliked(state, event);
    case "ItemTagged":
      return applyItemTagged(state, event);
    case "ItemUntagged":
      return applyItemUntagged(state, event);
    case "ItemTitleEdited":
      return applyItemTitleEdited(state, event);
    case "ItemDeleted":
      return applyItemDeleted(state, event);
    case "DeviceRegistered":
      return applyDeviceRegistered(state, event);
    case "DeviceRevoked":
      return applyDeviceRevoked(state, event);
    case "VaultDeletionScheduled":
      return applyVaultDeletionScheduled(state, event);
    case "VaultDeletionCancelled":
      return applyVaultDeletionCancelled(state, event);
    case "VaultDeleted":
      return applyVaultDeleted(state, event);
    default:
      // Forward-compat: an unknown `type` from a hand-built object is silently
      // ignored. The Zod `EventSchema` already rejects unknowns at the wire
      // boundary; this branch keeps the reducer safe if someone bypasses it.
      return state;
  }
}

export { initialVaultState };
export type { VaultState, Item, ItemState, DeviceRecord, ScheduledDeletion } from "./state.js";
