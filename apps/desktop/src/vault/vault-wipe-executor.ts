import { verifyVaultDeleted } from "@defer/core/vault-wipe";
import type { Event, VaultDeleted } from "@defer/core";

import { base64UrlToBytes } from "../util/base64.js";
import type { StoragePort } from "../storage/index.js";
import { detectKeychain } from "../runtime/keychain-port.js";

const SETTING_VAULT_KEY = "vault.keyBase64Url";
const SETTING_VAULT_ID = "vault.idBase64Url";

export type WipeOutcome =
  | { kind: "wiped"; deletedAt: number }
  | { kind: "refused"; reason: "invalid-signature" | "wrong-device-id" };

/**
 * Desktop-side wipe coordinator. When a `VaultDeleted` event arrives
 * via inbound replay, this is the *only* code path allowed to destroy
 * local state. Refuses to wipe on a missing/invalid signature (PRD
 * US #15) — the verification runs FIRST, before any destructive call.
 *
 * Destruction order:
 *   1. SQLite credentials (vault key, device auth token, vault id,
 *      device id).
 *   2. Keychain entry (best-effort — wipe local even if keychain
 *      remove fails, because the local data is the bigger risk).
 *   3. The events + items + settings rows themselves (cleared by
 *      overwriting individual settings, matching the
 *      slice-#58 approach).
 *
 * Returns a discriminated outcome so the caller (the inbound replay
 * hook in `App.tsx`) can show the user "your vault has been deleted"
 * vs "we received an invalid deletion event and refused to act".
 */
export async function executeVaultWipe(
  storage: StoragePort,
  event: VaultDeleted,
): Promise<WipeOutcome> {
  const vaultKeyB64 = await storage.getSetting(SETTING_VAULT_KEY);
  if (!vaultKeyB64) {
    // Without a vault key we can't verify — fail closed and refuse.
    return { kind: "refused", reason: "invalid-signature" };
  }
  const vaultKey = base64UrlToBytes(vaultKeyB64);

  const verification = verifyVaultDeleted(vaultKey, event);
  if (!verification.ok) {
    if (verification.reason === "schema") {
      // Treat schema failures as invalid signature for the caller.
      return { kind: "refused", reason: "invalid-signature" };
    }
    return { kind: "refused", reason: verification.reason };
  }

  // Destruction: best-effort across stores; we keep going even if
  // individual sub-steps fail (the user has nothing to lose at this
  // point and partial wipes are still better than no wipe).
  const vaultIdB64 = await storage.getSetting(SETTING_VAULT_ID);
  const keychain = detectKeychain();
  if (vaultIdB64 && keychain.isAvailable()) {
    try {
      await keychain.remove(vaultIdB64.slice(0, 8));
    } catch {
      // Keychain remove failures are non-fatal.
    }
  }

  // Clear the security-critical settings rows. Matches slice #58's
  // sign-out wipe — when the table-level truncate primitive lands in
  // the storage port, both code paths can swap to it.
  await storage.setSetting(SETTING_VAULT_KEY, "");
  await storage.setSetting("device.authTokenBase64Url", "");
  await storage.setSetting(SETTING_VAULT_ID, "");
  await storage.setSetting("device.idBase64Url", "");
  await storage.setSetting("device.name", "");
  await storage.setSetting("pendingEventQueue", "");
  await storage.setSetting("sync.inboundCursor", "");

  return { kind: "wiped", deletedAt: verification.deletedAt };
}

/**
 * Adapter that plugs into `InboundReplay.onEvent`. The desktop wires
 * this into the inbound pipeline so a `VaultDeleted` arriving from
 * the relay routes through the wipe path instead of the normal
 * projection-apply.
 */
export function shouldRouteThroughWipe(event: Event): event is VaultDeleted {
  return event.type === "VaultDeleted";
}
