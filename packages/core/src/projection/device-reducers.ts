import type { DeviceRegistered, DeviceRevoked } from "../events/index.js";
import type { VaultState } from "./state.js";

export function applyDeviceRegistered(state: VaultState, event: DeviceRegistered): VaultState {
  const { deviceId, deviceName, deviceType, registeredAt } = event.data;
  if (state.devices.has(deviceId)) return state;

  const devices = new Map(state.devices);
  devices.set(deviceId, {
    name: deviceName,
    type: deviceType,
    registeredAt,
  });
  return { ...state, devices };
}

export function applyDeviceRevoked(state: VaultState, event: DeviceRevoked): VaultState {
  const { deviceId } = event.data;
  if (!state.devices.has(deviceId)) return state;

  const devices = new Map(state.devices);
  devices.delete(deviceId);
  return { ...state, devices };
}
