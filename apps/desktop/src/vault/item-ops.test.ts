import { describe, expect, it } from "vitest";
import { ready } from "@defer/core/crypto";
import { PendingEventQueue } from "@defer/core/pending-event-queue";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { VaultProjectionStore } from "./projection-store.js";
import { VaultCommands } from "./commands.js";
import { SqlitePendingQueueStorage } from "./pending-queue-adapter.js";

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL, { now: () => 1_700_000_000_000 });
  await storage.init();
  const projection = new VaultProjectionStore(storage);
  const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));
  const commands = new VaultCommands({
    storage,
    projection,
    pendingQueue,
    deviceId: "device-AAAAAAAAAAAAA",
    now: () => 1_700_000_000_000,
  });
  await commands.save("https://example.com/article");
  const itemId = projection.getItemsSortedBySavedAtDesc()[0]?.id;
  if (!itemId) throw new Error("save did not produce an item");
  return { storage, projection, commands, pendingQueue, itemId };
}

describe("VaultCommands.archive / unarchive", () => {
  it("moves an item from inbox to archive and back", async () => {
    const { commands, projection, itemId } = await setup();
    await commands.archive(itemId);
    expect(projection.getState().items.get(itemId)?.state).toBe("archive");
    await commands.unarchive(itemId);
    expect(projection.getState().items.get(itemId)?.state).toBe("inbox");
  });
});

describe("VaultCommands.like / unlike", () => {
  it("toggles the liked flag independent of state", async () => {
    const { commands, projection, itemId } = await setup();
    await commands.like(itemId);
    expect(projection.getState().items.get(itemId)?.liked).toBe(true);
    expect(projection.getState().items.get(itemId)?.state).toBe("inbox");
    await commands.archive(itemId);
    expect(projection.getState().items.get(itemId)?.liked).toBe(true);
    await commands.unlike(itemId);
    expect(projection.getState().items.get(itemId)?.liked).toBe(false);
  });
});

describe("VaultCommands.editTitle", () => {
  it("updates the title in the projection and persists to the items table", async () => {
    const { commands, projection, storage, itemId } = await setup();
    await commands.editTitle(itemId, "Renamed article");
    expect(projection.getState().items.get(itemId)?.title).toBe("Renamed article");
    const persistedItems = await storage.allItems();
    expect(persistedItems.find((i) => i.id === itemId)?.title).toBe("Renamed article");
  });
});

describe("VaultCommands.deleteItem", () => {
  it("hides the item from allItems and excludes it from the projection's visible map", async () => {
    const { commands, projection, storage, itemId } = await setup();
    await commands.deleteItem(itemId);
    const stillThere = projection.getState().items.get(itemId);
    expect(stillThere?.deletedAt).not.toBeNull();
    const visibleItems = await storage.allItems();
    expect(visibleItems.find((i) => i.id === itemId)).toBeUndefined();
  });
});

describe("VaultCommands — every op enqueues for outbound flush", () => {
  it("each command appends a row to events and an entry to the pending queue", async () => {
    const { commands, storage, pendingQueue, itemId } = await setup();
    const before = (await storage.allEvents()).length;
    await commands.archive(itemId);
    await commands.like(itemId);
    await commands.editTitle(itemId, "x");
    await commands.deleteItem(itemId);

    const events = await storage.allEvents();
    expect(events.length - before).toBe(4);

    const pending = await pendingQueue.peek();
    // 1 ItemSaved (from setup) + 4 ops = 5
    expect(pending.length).toBe(5);
  });
});
