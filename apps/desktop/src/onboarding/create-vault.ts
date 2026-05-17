import { ready, generateVaultKey, generateDeviceId } from "@defer/core/crypto";
import { deriveVaultIdFromKey, encodeVaultKey } from "@defer/core";

import { bytesToBase64Url } from "../util/base64.js";
import type { StoragePort } from "../storage/index.js";

const SETTING_VAULT_KEY = "vault.keyBase64Url";
const SETTING_VAULT_ID = "vault.idBase64Url";
const SETTING_DEVICE_ID = "device.idBase64Url";
const SETTING_DEVICE_NAME = "device.name";

export type CreatedVault = {
  vaultKey: Uint8Array;
  vaultId: Uint8Array;
  /** 24 BIP-39 words. */
  mnemonic: string;
  deviceId: string;
};

export type LoadedVault = {
  vaultIdBase64Url: string;
  deviceId: string;
  deviceName: string;
};

/**
 * Generates a fresh vault key, derives the vault ID (HKDF), mints a 16-byte
 * device ID, and stages the values for the onboarding flow to commit via
 * `persistVault(...)`. Splitting generation from persistence lets the
 * mnemonic-verification step run *before* anything is written to disk — if
 * the user closes the app mid-onboarding nothing partial is persisted.
 */
export async function createVault(): Promise<CreatedVault> {
  await ready;
  const vaultKey = generateVaultKey();
  const vaultId = deriveVaultIdFromKey(vaultKey);
  const mnemonic = encodeVaultKey(vaultKey);
  const deviceId = bytesToBase64Url(generateDeviceId());
  return { vaultKey, vaultId, mnemonic, deviceId };
}

/**
 * Commits the staged vault to local storage. The vault key is stored on
 * disk as base64url — slice #55 moves it to the OS keychain via the
 * `keyring` crate; until then the file-on-disk path is the source of
 * truth and the user is expected to back up their mnemonic.
 */
export async function persistVault(
  storage: StoragePort,
  vault: CreatedVault,
  deviceName: string,
): Promise<void> {
  await storage.setSetting(SETTING_VAULT_KEY, bytesToBase64Url(vault.vaultKey));
  await storage.setSetting(SETTING_VAULT_ID, bytesToBase64Url(vault.vaultId));
  await storage.setSetting(SETTING_DEVICE_ID, vault.deviceId);
  await storage.setSetting(SETTING_DEVICE_NAME, deviceName);
}

export async function loadVault(storage: StoragePort): Promise<LoadedVault | null> {
  const vaultId = await storage.getSetting(SETTING_VAULT_ID);
  const deviceId = await storage.getSetting(SETTING_DEVICE_ID);
  const deviceName = await storage.getSetting(SETTING_DEVICE_NAME);
  if (vaultId === undefined || deviceId === undefined || deviceName === undefined) return null;
  return { vaultIdBase64Url: vaultId, deviceId, deviceName };
}

/**
 * Returns the unguessable OS-derived default name for this device. Slice
 * #46 ships `deviceIdentity.suggestDeviceName()` in `@defer/core` that this
 * thin wrapper will defer to; for slice #45 we use a stand-in so the
 * onboarding flow has *something* to write to the `device.name` setting.
 *
 * Why "stand-in" rather than wiring the real heuristic now: the heuristic
 * needs OS user info + UA info, which is only available inside the Tauri
 * runtime. Slice #46 owns the full implementation and the Tauri-bridge
 * adapter.
 */
export function defaultDeviceName(fallback: string = "This device"): string {
  if (typeof globalThis.navigator !== "undefined") {
    const platform = globalThis.navigator.platform ?? "";
    if (platform.startsWith("Mac")) return "Mac";
    if (platform.startsWith("Win")) return "Windows PC";
    if (platform.startsWith("Linux")) return "Linux PC";
  }
  return fallback;
}
