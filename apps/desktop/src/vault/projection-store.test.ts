import { describe, expect, it, vi } from "vitest";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { VaultProjectionStore } from "./projection-store.js";

async function makeStorage() {
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL, { now: () => 1_700_000_000_000 });
  await storage.init();
  return storage;
}

describe("VaultProjectionStore", () => {
  it("starts empty before hydrate", async () => {
    const storage = await makeStorage();
    const store = new VaultProjectionStore(storage);
    expect(store.getState().items.size).toBe(0);
  });

  it("applies an event and notifies subscribers", async () => {
    const storage = await makeStorage();
    const store = new VaultProjectionStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    store.apply({
      type: "ItemSaved",
      seq: 1,
      deviceId: "device-a",
      timestamp: 100,
      clientNonce: "AAAAAAAAAAAAAAAAAAAAAA",
      data: {
        itemId: "item-1",
        url: "https://example.com/",
        canonicalUrl: "https://example.com/",
        title: "Example",
        savedAt: 100,
      },
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState().items.size).toBe(1);
  });

  it("hydrates from the events table", async () => {
    const storage = await makeStorage();
    const payload = JSON.stringify({
      type: "ItemSaved",
      seq: 0,
      deviceId: "device-a",
      timestamp: 100,
      clientNonce: "AAAAAAAAAAAAAAAAAAAAAA",
      data: {
        itemId: "item-1",
        url: "https://example.com/",
        canonicalUrl: "https://example.com/",
        title: "Example",
        savedAt: 100,
      },
    });
    await storage.appendEvent({
      seq: null,
      type: "ItemSaved",
      deviceId: "device-a",
      clientNonce: "AAAAAAAAAAAAAAAAAAAAAA",
      timestamp: 100,
      payload,
    });
    const store = new VaultProjectionStore(storage);
    await store.hydrate();
    expect(store.getState().items.size).toBe(1);
  });

  it("skips malformed payload rows during hydrate", async () => {
    const storage = await makeStorage();
    await storage.appendEvent({
      seq: null,
      type: "ItemSaved",
      deviceId: "device-a",
      clientNonce: "AAAAAAAAAAAAAAAAAAAAAA",
      timestamp: 100,
      payload: "not-json",
    });
    const store = new VaultProjectionStore(storage);
    await store.hydrate();
    expect(store.getState().items.size).toBe(0);
  });
});
