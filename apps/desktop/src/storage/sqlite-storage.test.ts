import { describe, expect, it } from "vitest";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "./sqlite-storage.js";
import { readSchemaVersion } from "./migrations.js";

async function makeStorage() {
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL, { now: () => 1_700_000_000_000 });
  await storage.init();
  return { storage, SQL };
}

describe("SqliteStorage", () => {
  it("applies migrations on init and bumps schema_version", async () => {
    const { storage, SQL } = await makeStorage();
    const exported = storage.exportBytes();
    const db = new SQL.Database(exported);
    expect(readSchemaVersion(db)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("round-trips events in (seq IS NULL, seq, row_id) order", async () => {
    const { storage } = await makeStorage();
    await storage.appendEvent({
      seq: 2,
      type: "ItemSaved",
      deviceId: "device-a",
      clientNonce: "nonce-a",
      timestamp: 1,
      payload: JSON.stringify({ type: "ItemSaved", data: { id: "a" } }),
    });
    await storage.appendEvent({
      seq: null,
      type: "ItemSaved",
      deviceId: "device-a",
      clientNonce: "nonce-b",
      timestamp: 2,
      payload: JSON.stringify({ type: "ItemSaved", data: { id: "b" } }),
    });
    await storage.appendEvent({
      seq: 1,
      type: "ItemSaved",
      deviceId: "device-a",
      clientNonce: "nonce-c",
      timestamp: 3,
      payload: JSON.stringify({ type: "ItemSaved", data: { id: "c" } }),
    });

    const events = await storage.allEvents();
    expect(events.map((e) => e.clientNonce)).toEqual(["nonce-c", "nonce-a", "nonce-b"]);
  });

  it("idempotently appends an event with the same (deviceId, clientNonce)", async () => {
    const { storage } = await makeStorage();
    for (let i = 0; i < 3; i += 1) {
      await storage.appendEvent({
        seq: null,
        type: "ItemSaved",
        deviceId: "device-a",
        clientNonce: "dup",
        timestamp: i,
        payload: "{}",
      });
    }
    const events = await storage.allEvents();
    expect(events).toHaveLength(1);
  });

  it("upserts items via putItem and reads them back via allItems", async () => {
    const { storage } = await makeStorage();
    await storage.putItem({
      id: "item-1",
      url: "https://example.com",
      canonicalUrl: "https://example.com",
      title: "Example",
      state: "inbox",
      liked: false,
      tags: ["a", "b"],
      savedAt: 1,
      createdAt: 1,
      deletedAt: null,
    });
    await storage.putItem({
      id: "item-1",
      url: "https://example.com",
      canonicalUrl: "https://example.com",
      title: "Example (updated)",
      state: "archive",
      liked: true,
      tags: ["a"],
      savedAt: 2,
      createdAt: 1,
      deletedAt: null,
    });
    const items = await storage.allItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Example (updated)");
    expect(items[0]?.state).toBe("archive");
    expect(items[0]?.liked).toBe(true);
    expect(items[0]?.tags).toEqual(["a"]);
  });

  it("hides soft-deleted items from allItems", async () => {
    const { storage } = await makeStorage();
    await storage.putItem({
      id: "item-1",
      url: "https://example.com",
      canonicalUrl: "https://example.com",
      title: "Gone",
      state: "inbox",
      liked: false,
      tags: [],
      savedAt: 1,
      createdAt: 1,
      deletedAt: 2,
    });
    expect(await storage.allItems()).toEqual([]);
  });

  it("stores and reads settings", async () => {
    const { storage } = await makeStorage();
    await storage.setSetting("foo", "bar");
    expect(await storage.getSetting("foo")).toBe("bar");
    await storage.setSetting("foo", "baz");
    expect(await storage.getSetting("foo")).toBe("baz");
    expect(await storage.getSetting("missing")).toBeUndefined();
  });
});
