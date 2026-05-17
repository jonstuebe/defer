import { describe, expect, it } from "vitest";
import { ready } from "@defer/core/crypto";
import { PendingEventQueue } from "@defer/core/pending-event-queue";
import type { VaultDeletionScheduled } from "@defer/core";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { createVault, persistVault } from "../onboarding/create-vault.js";
import { VaultProjectionStore } from "./projection-store.js";
import { SqlitePendingQueueStorage } from "./pending-queue-adapter.js";
import {
  cancelVaultDeletion,
  scheduleVaultDeletion,
  verifyVaultDeletionScheduled,
} from "./vault-deletion-scheduler.js";

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  const vault = await createVault();
  await persistVault(storage, vault, "Test device");
  const projection = new VaultProjectionStore(storage);
  const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));
  return { storage, vault, projection, pendingQueue };
}

describe("scheduleVaultDeletion", () => {
  it("emits a vault-key-MAC'd VaultDeletionScheduled with scheduledFor = now + 48h", async () => {
    const { storage, vault, projection, pendingQueue } = await setup();
    const now = 1_700_000_000_000;
    await scheduleVaultDeletion({
      storage,
      projection,
      pendingQueue,
      deviceId: vault.deviceId,
      now: () => now,
    });

    expect(projection.getState().scheduledDeletion).not.toBeNull();
    expect(projection.getState().scheduledDeletion?.scheduledFor).toBe(now + 48 * 60 * 60 * 1000);

    const events = await storage.allEvents();
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]?.payload ?? "{}") as VaultDeletionScheduled;
    expect(parsed.type).toBe("VaultDeletionScheduled");
    expect(verifyVaultDeletionScheduled(vault.vaultKey, parsed)).toBe(true);
  });

  it("requires an initialized vault", async () => {
    const SQL = await initSqlForNode();
    const storage = new SqliteStorage(SQL);
    await storage.init();
    const projection = new VaultProjectionStore(storage);
    const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));
    await expect(
      scheduleVaultDeletion({
        storage,
        projection,
        pendingQueue,
        deviceId: "x",
        now: () => 1,
      }),
    ).rejects.toThrow(/vault not initialized/);
  });
});

describe("cancelVaultDeletion", () => {
  it("emits VaultDeletionCancelled and clears the projection's scheduledDeletion slot", async () => {
    const { storage, vault, projection, pendingQueue } = await setup();
    const now = 1_700_000_000_000;
    await scheduleVaultDeletion({
      storage,
      projection,
      pendingQueue,
      deviceId: vault.deviceId,
      now: () => now,
    });
    expect(projection.getState().scheduledDeletion).not.toBeNull();

    await cancelVaultDeletion({
      storage,
      projection,
      pendingQueue,
      deviceId: vault.deviceId,
      now: () => now + 1000,
    });

    expect(projection.getState().scheduledDeletion).toBeNull();
    const events = await storage.allEvents();
    expect(events.map((e) => e.type)).toContain("VaultDeletionCancelled");
  });
});

describe("verifyVaultDeletionScheduled", () => {
  it("rejects an event MAC'd by a different vault key", async () => {
    const { storage, vault, projection, pendingQueue } = await setup();
    await scheduleVaultDeletion({
      storage,
      projection,
      pendingQueue,
      deviceId: vault.deviceId,
      now: () => 1_700_000_000_000,
    });
    const events = await storage.allEvents();
    const parsed = JSON.parse(events[0]?.payload ?? "{}") as VaultDeletionScheduled;
    const wrongKey = new Uint8Array(32).fill(0xfe);
    expect(verifyVaultDeletionScheduled(wrongKey, parsed)).toBe(false);
  });
});
