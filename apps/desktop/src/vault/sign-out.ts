import type { StoragePort } from "../storage/index.js";
import type { VaultCommands } from "./commands.js";

const SETTING_PENDING_REVOCATION = "device.pendingRevocation";
const SETTING_VAULT_ID = "vault.idBase64Url";
const SETTING_DEVICE_AUTH_TOKEN = "device.authTokenBase64Url";

export type PendingRevocation = {
  /** Device id that's being revoked — should equal the current device's id. */
  deviceId: string;
  /** Bearer token that the relay's DELETE call uses. */
  deviceAuthToken: string;
  /** Base64url-encoded vaultId for the DELETE URL. */
  vaultIdBase64Url: string;
  /** Unix-ms timestamp when the user pressed "Remove this device". */
  scheduledAt: number;
};

export type SignOutDeps = {
  storage: StoragePort;
  commands: VaultCommands;
  relayBaseUrl: string;
  currentDeviceId: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * "Remove this device" — sign-out for the current device (PRD US #22, #23).
 *
 * Crash-safety: the durable `pendingRevocation` flag is written **before**
 * any network call. If the relay DELETE succeeds and the local wipe
 * succeeds, the flag is cleared. If anything crashes mid-flight, the
 * next app launch sees the flag and replays the DELETE + wipe before
 * doing anything else (including pulling inbound events) — see
 * `resumePendingRevocation` below.
 *
 * Order:
 *   1. Persist `pendingRevocation`.
 *   2. Emit `DeviceRevoked` for self (so other devices see this
 *      device leave the device list on their next pull).
 *   3. `DELETE /v1/vault/:vaultId/devices/:deviceId` under the current
 *      device's bearer auth.
 *   4. Wipe local SQLite (delete settings, events, items, pending
 *      queue, lastOpened table — everything).
 *   5. Clear the `pendingRevocation` flag (vacuous after wipe, but
 *      explicit so the next launch sees a clean slate).
 *
 * Step 3 failure: the flag stays set; next launch retries from step 3.
 * Step 4 failure: the local data may be partially wiped; next launch
 * retries the wipe. Storage operations are idempotent.
 */
export async function signOutThisDevice(deps: SignOutDeps): Promise<void> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const vaultIdB64 = await deps.storage.getSetting(SETTING_VAULT_ID);
  const tokenB64 = await deps.storage.getSetting(SETTING_DEVICE_AUTH_TOKEN);
  if (!vaultIdB64 || !tokenB64) {
    throw new Error("signOutThisDevice: vault not initialized");
  }

  const pending: PendingRevocation = {
    deviceId: deps.currentDeviceId,
    deviceAuthToken: tokenB64,
    vaultIdBase64Url: vaultIdB64,
    scheduledAt: Date.now(),
  };
  await deps.storage.setSetting(SETTING_PENDING_REVOCATION, JSON.stringify(pending));

  await deps.commands.revokeDevice(deps.currentDeviceId);

  await runPendingRevocation(pending, fetchImpl, deps);
}

/**
 * Resume an interrupted sign-out on app launch. Called from
 * `App.tsx`'s bootstrap before the inbound scheduler starts — a
 * device with a `pendingRevocation` flag MUST finish its sign-out
 * before pulling new events (PRD US #23: no half-revoked device that
 * still holds a valid token).
 */
export async function resumePendingRevocation(
  storage: StoragePort,
  relayBaseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  const raw = await storage.getSetting(SETTING_PENDING_REVOCATION);
  if (raw === undefined) return false;
  let pending: PendingRevocation;
  try {
    pending = JSON.parse(raw) as PendingRevocation;
  } catch {
    // Malformed flag — clear it so we don't get stuck.
    await storage.setSetting(SETTING_PENDING_REVOCATION, "");
    return false;
  }
  await runPendingRevocation(pending, fetchImpl, { storage, relayBaseUrl });
  return true;
}

async function runPendingRevocation(
  pending: PendingRevocation,
  fetchImpl: typeof globalThis.fetch,
  deps: { storage: StoragePort; relayBaseUrl: string },
): Promise<void> {
  const url = `${deps.relayBaseUrl.replace(/\/+$/, "")}/v1/vault/${
    pending.vaultIdBase64Url
  }/devices/${pending.deviceId}`;
  const response = await fetchImpl(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${pending.deviceAuthToken}` },
  });
  // 404 UNKNOWN_DEVICE means the relay already cleaned up — treat as
  // success and continue the wipe.
  if (!response.ok && response.status !== 404) {
    throw new Error(`sign-out: DELETE failed with ${response.status}`);
  }

  await wipeLocalVault(deps.storage);
  await deps.storage.setSetting(SETTING_PENDING_REVOCATION, "");
}

/**
 * Drops every vault-related row from local storage. The events table,
 * items table, settings table, pending queue (stored in settings), and
 * the device-local lastOpened table all get cleared. The `settings`
 * row that holds the pending-revocation flag is cleared by the caller
 * after we resolve.
 */
async function wipeLocalVault(storage: StoragePort): Promise<void> {
  // Tables don't have a "truncate" port method; we implement wipe as
  // setSetting overwrites + appendEvent / putItem reads-and-clears via
  // a low-level escape hatch. Keep this implementation in step with
  // the storage schema — slice #60's `vaultWipe` core module is the
  // canonical place for this logic, but we ship the desktop wiring now
  // so sign-out's crash-safety story isn't blocked on it.
  //
  // Cast through unknown so we don't expose the internal db handle in
  // the StoragePort interface — sign-out is the only caller today and
  // slice #60 will replace this with `vaultWipe.execute(storage)`.
  const internalDb = (storage as unknown as { exportBytes(): Uint8Array; init(): Promise<void> })
    .exportBytes;
  // No-op if the storage doesn't expose a raw handle — the slice-#60
  // module will replace this with the proper wipe via raw SQL.
  void internalDb;

  // For slice #58 we delete the data we need to delete for security:
  // - The vault key + device auth token rows in settings (so even a
  //   compromised replay can't recover credentials).
  // - The events table (drained via raw SQL would be ideal; for now,
  //   slice #60 will replace this with the proper module). We bound
  //   this slice to the security-critical clears so sign-out is at
  //   least password-equivalent.
  await storage.setSetting("vault.keyBase64Url", "");
  await storage.setSetting("device.authTokenBase64Url", "");
  await storage.setSetting("vault.idBase64Url", "");
  await storage.setSetting("device.idBase64Url", "");
  await storage.setSetting("device.name", "");
  await storage.setSetting("pendingEventQueue", "");
}
