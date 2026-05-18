import { describe, expect, it, vi } from "vitest";
import { ready } from "@defer/core/crypto";
import { PendingEventQueue } from "@defer/core/pending-event-queue";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { createVault, persistVault } from "../onboarding/create-vault.js";
import { VaultProjectionStore } from "./projection-store.js";
import { VaultCommands } from "./commands.js";
import { SqlitePendingQueueStorage } from "./pending-queue-adapter.js";
import { ensureDeviceAuthToken } from "./relay-config.js";
import { resumePendingRevocation, signOutThisDevice } from "./sign-out.js";

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  const vault = await createVault();
  await persistVault(storage, vault, "Test device");
  await ensureDeviceAuthToken(storage);
  const projection = new VaultProjectionStore(storage);
  const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));
  const commands = new VaultCommands({
    storage,
    projection,
    pendingQueue,
    deviceId: vault.deviceId,
    now: () => 1_700_000_000_000,
  });
  return { storage, vault, projection, commands };
}

describe("signOutThisDevice", () => {
  it("writes pendingRevocation flag BEFORE the network call (crash-safety)", async () => {
    const { storage, commands, vault } = await setup();

    let flagBeforeDelete: string | undefined;
    const fetchMock = vi.fn().mockImplementation(async () => {
      flagBeforeDelete = await storage.getSetting("device.pendingRevocation");
      return new Response(null, { status: 204 });
    });

    await signOutThisDevice({
      storage,
      commands,
      relayBaseUrl: "https://relay.example",
      currentDeviceId: vault.deviceId,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    // The flag was set before fetch ran.
    expect(flagBeforeDelete).toBeDefined();
    const parsed = JSON.parse(flagBeforeDelete ?? "{}");
    expect(parsed.deviceId).toBe(vault.deviceId);

    // After success, the flag is cleared (empty string sentinel).
    expect(await storage.getSetting("device.pendingRevocation")).toBe("");

    // Vault credentials are wiped.
    expect(await storage.getSetting("vault.keyBase64Url")).toBe("");
    expect(await storage.getSetting("device.authTokenBase64Url")).toBe("");
  });

  it("treats 404 as already-revoked and proceeds with wipe", async () => {
    const { storage, commands, vault } = await setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await signOutThisDevice({
      storage,
      commands,
      relayBaseUrl: "https://relay.example",
      currentDeviceId: vault.deviceId,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(await storage.getSetting("vault.keyBase64Url")).toBe("");
  });

  it("keeps the flag and throws on a non-2xx-non-404 response", async () => {
    const { storage, commands, vault } = await setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response("oops", { status: 500 }));

    await expect(
      signOutThisDevice({
        storage,
        commands,
        relayBaseUrl: "https://relay.example",
        currentDeviceId: vault.deviceId,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/DELETE failed/);

    const flag = await storage.getSetting("device.pendingRevocation");
    expect(flag).toBeDefined();
    expect(flag).not.toBe("");
    // Vault credentials are NOT wiped on failed network call (so the
    // user retries instead of being left locked out).
    expect(await storage.getSetting("vault.keyBase64Url")).not.toBe("");
  });
});

describe("resumePendingRevocation", () => {
  it("retries the DELETE + wipe when the flag is set on launch", async () => {
    const { storage, commands, vault } = await setup();
    // Set up a stuck pending-revocation by crashing the first attempt.
    const fetchMockCrashed = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(
      signOutThisDevice({
        storage,
        commands,
        relayBaseUrl: "https://relay.example",
        currentDeviceId: vault.deviceId,
        fetch: fetchMockCrashed as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/offline/);
    expect(await storage.getSetting("device.pendingRevocation")).toBeDefined();

    // Now relaunch — resume should complete the operation.
    const fetchMockSuccess = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const resumed = await resumePendingRevocation(
      storage,
      "https://relay.example",
      fetchMockSuccess as unknown as typeof globalThis.fetch,
    );
    expect(resumed).toBe(true);
    expect(await storage.getSetting("device.pendingRevocation")).toBe("");
    expect(await storage.getSetting("vault.keyBase64Url")).toBe("");
  });

  it("returns false when no flag is set", async () => {
    const { storage } = await setup();
    expect(
      await resumePendingRevocation(
        storage,
        "https://relay.example",
        vi.fn() as unknown as typeof globalThis.fetch,
      ),
    ).toBe(false);
  });
});
