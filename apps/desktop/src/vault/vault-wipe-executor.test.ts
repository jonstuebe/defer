import { describe, expect, it } from "vitest";
import { ready, signWithVaultKey } from "@defer/core/crypto";
import { envelopeForSigning } from "@defer/core/crypto";
import { RELAY_DEVICE_ID, type VaultDeleted } from "@defer/core";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { createVault, persistVault } from "../onboarding/create-vault.js";
import { ensureDeviceAuthToken } from "./relay-config.js";
import { executeVaultWipe } from "./vault-wipe-executor.js";
import { bytesToBase64Url } from "../util/base64.js";

async function makeSignedDeletedEvent(
  vaultKey: Uint8Array,
  deviceId: string = RELAY_DEVICE_ID,
): Promise<VaultDeleted> {
  const unsigned = {
    type: "VaultDeleted" as const,
    seq: 1,
    deviceId,
    timestamp: 1_700_000_000_000,
    clientNonce: "BBBBBBBBBBBBBBBBBBBBBB",
    data: { deletedAt: 1_700_000_000_999 },
  };
  const sig = signWithVaultKey(
    vaultKey,
    envelopeForSigning(unsigned as unknown as Record<string, unknown>),
  );
  return { ...unsigned, signature: bytesToBase64Url(sig) } as VaultDeleted;
}

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  const vault = await createVault();
  await persistVault(storage, vault, "Test device");
  await ensureDeviceAuthToken(storage);
  return { storage, vault };
}

describe("executeVaultWipe", () => {
  it("wipes credentials on a valid VaultDeleted event", async () => {
    const { storage, vault } = await setup();
    const event = await makeSignedDeletedEvent(vault.vaultKey);

    const result = await executeVaultWipe(storage, event);

    expect(result.kind).toBe("wiped");
    expect(await storage.getSetting("vault.keyBase64Url")).toBe("");
    expect(await storage.getSetting("device.authTokenBase64Url")).toBe("");
    expect(await storage.getSetting("vault.idBase64Url")).toBe("");
  });

  it("REFUSES to wipe on a wrong-deviceId event (signature would have been valid)", async () => {
    const { storage, vault } = await setup();
    const event = await makeSignedDeletedEvent(vault.vaultKey, "real-deviceAAAAAAAAAA");

    const result = await executeVaultWipe(storage, event);

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("wrong-device-id");
    // Critically: credentials are still present.
    expect(await storage.getSetting("vault.keyBase64Url")).not.toBe("");
  });

  it("REFUSES to wipe on an invalid-signature event", async () => {
    const { storage, vault } = await setup();
    const event = await makeSignedDeletedEvent(vault.vaultKey);
    const tampered: VaultDeleted = { ...event, data: { deletedAt: 0 } };

    const result = await executeVaultWipe(storage, tampered);

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("invalid-signature");
    expect(await storage.getSetting("vault.keyBase64Url")).not.toBe("");
  });
});
