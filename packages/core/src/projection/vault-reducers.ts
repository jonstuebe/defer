import type {
  VaultDeletionScheduled,
  VaultDeletionCancelled,
  VaultDeleted,
} from "../events/index.js";
import type { VaultState } from "./state.js";

export function applyVaultDeletionScheduled(
  state: VaultState,
  event: VaultDeletionScheduled,
): VaultState {
  return {
    ...state,
    scheduledDeletion: {
      scheduledFor: event.data.scheduledFor,
      scheduledBy: event.deviceId,
    },
  };
}

export function applyVaultDeletionCancelled(
  state: VaultState,
  _event: VaultDeletionCancelled,
): VaultState {
  return { ...state, scheduledDeletion: null };
}

export function applyVaultDeleted(state: VaultState, _event: VaultDeleted): VaultState {
  return { ...state, isDeleted: true };
}
