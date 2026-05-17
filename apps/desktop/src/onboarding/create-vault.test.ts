import { describe, expect, it } from "vitest";
import { decodeMnemonic, deriveVaultIdFromKey } from "@defer/core";

import { createVault, persistVault, loadVault, defaultDeviceName } from "./create-vault.js";
import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";

async function makeStorage() {
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL, { now: () => 1_700_000_000_000 });
  await storage.init();
  return storage;
}

describe("createVault", () => {
  it("returns a 24-word mnemonic that decodes back to the vault key", async () => {
    const vault = await createVault();
    expect(vault.mnemonic.trim().split(/\s+/)).toHaveLength(24);
    const decoded = decodeMnemonic(vault.mnemonic);
    expect(decoded).toEqual(vault.vaultKey);
  });

  it("derives the vault ID via HKDF on the vault key", async () => {
    const vault = await createVault();
    const derived = deriveVaultIdFromKey(vault.vaultKey);
    expect(derived).toEqual(vault.vaultId);
  });
});

describe("persistVault + loadVault", () => {
  it("round-trips the vault identity through settings", async () => {
    const storage = await makeStorage();
    const vault = await createVault();
    await persistVault(storage, vault, "Test Mac");
    const loaded = await loadVault(storage);
    expect(loaded).not.toBeNull();
    expect(loaded?.deviceId).toBe(vault.deviceId);
    expect(loaded?.deviceName).toBe("Test Mac");
  });

  it("returns null on a fresh storage with no vault written", async () => {
    const storage = await makeStorage();
    expect(await loadVault(storage)).toBeNull();
  });
});

describe("defaultDeviceName", () => {
  it("returns a string", () => {
    expect(typeof defaultDeviceName()).toBe("string");
    expect(defaultDeviceName().length).toBeGreaterThan(0);
  });
});
