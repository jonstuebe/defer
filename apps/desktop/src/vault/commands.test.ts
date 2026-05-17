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
  const now = () => 1_700_000_000_000;
  const commands = new VaultCommands({
    storage,
    projection,
    pendingQueue,
    deviceId: "device-a",
    now,
  });
  return { storage, projection, commands, pendingQueue };
}

describe("VaultCommands.save", () => {
  it("canonicalizes the URL and records ItemSaved in the projection", async () => {
    const { commands, projection } = await setup();
    await commands.save("https://example.com/?utm_source=test#frag");

    const items = projection.getItemsSortedBySavedAtDesc();
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toBeDefined();
    expect(item?.canonicalUrl).toBe("https://example.com/");
    expect(item?.url).toBe("https://example.com/?utm_source=test#frag");
    expect(item?.state).toBe("inbox");
  });

  it("touches an existing item when the same canonical URL is saved again", async () => {
    const { commands, projection } = await setup();
    await commands.save("https://example.com/article");
    const firstItem = projection.getItemsSortedBySavedAtDesc()[0];
    expect(firstItem).toBeDefined();
    const firstId = firstItem?.id;

    await commands.save("https://example.com/article?utm_source=newsletter");
    const items = projection.getItemsSortedBySavedAtDesc();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(firstId);
  });

  it("persists the event to storage and enqueues it for outbound flush", async () => {
    const { commands, storage, pendingQueue } = await setup();
    await commands.save("https://example.com/");

    const events = await storage.allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBeNull();

    const pending = await pendingQueue.peek();
    expect(pending).toHaveLength(1);

    const decoded = JSON.parse(new TextDecoder().decode(pending[0]?.event));
    expect(decoded.type).toBe("ItemSaved");
    expect(decoded.data.canonicalUrl).toBe("https://example.com/");
  });

  it("strips tracking parameters via @defer/core's canonicalize", async () => {
    const { commands, projection } = await setup();
    await commands.save("https://example.com/page?fbclid=abc&utm_medium=email&keep=yes");
    const item = projection.getItemsSortedBySavedAtDesc()[0];
    expect(item).toBeDefined();
    expect(item?.canonicalUrl).toBe("https://example.com/page?keep=yes");
  });
});
