import { describe, expect, it, vi } from "vitest";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { LastOpenedStore } from "./last-opened-store.js";

async function makeStorage() {
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  return storage;
}

describe("LastOpenedStore", () => {
  it("returns an empty snapshot before any items are opened", async () => {
    const storage = await makeStorage();
    const store = new LastOpenedStore(storage);
    await store.hydrate();
    expect(store.getSnapshot().size).toBe(0);
  });

  it("persists markOpened to SQLite and updates the snapshot", async () => {
    const storage = await makeStorage();
    const store = new LastOpenedStore(storage);
    await store.hydrate();
    await store.markOpened("item-1", 1000);
    expect(store.getSnapshot().get("item-1")).toBe(1000);

    // Re-hydrate from a fresh store to verify durability.
    const fresh = new LastOpenedStore(storage);
    await fresh.hydrate();
    expect(fresh.getSnapshot().get("item-1")).toBe(1000);
  });

  it("notifies subscribers on markOpened", async () => {
    const storage = await makeStorage();
    const store = new LastOpenedStore(storage);
    await store.hydrate();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.markOpened("item-1", 1000);
    expect(listener).toHaveBeenCalled();
  });

  it("does NOT propagate to the events table (proves NOT-an-event invariant)", async () => {
    // Read-state is local-only per CONTEXT.md. Opening an item must not
    // produce any event in the synced log — a paired device replaying
    // would not see this signal at all.
    const storage = await makeStorage();
    const store = new LastOpenedStore(storage);
    await store.hydrate();
    await store.markOpened("item-1", 1000);
    const events = await storage.allEvents();
    expect(events).toEqual([]);
  });
});
