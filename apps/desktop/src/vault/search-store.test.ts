import { describe, expect, it } from "vitest";
import { ready } from "@defer/core/crypto";
import { PendingEventQueue } from "@defer/core/pending-event-queue";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { VaultProjectionStore } from "./projection-store.js";
import { VaultCommands } from "./commands.js";
import { SqlitePendingQueueStorage } from "./pending-queue-adapter.js";
import { SearchStore } from "./search-store.js";

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  const projection = new VaultProjectionStore(storage);
  const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));
  const search = new SearchStore();
  const commands = new VaultCommands({
    storage,
    projection,
    pendingQueue,
    searchStore: search,
    deviceId: "deviceAAAAAAAAAAAAAAA",
    now: () => 1_700_000_000_000,
  });
  return { storage, projection, search, commands };
}

describe("SearchStore", () => {
  it("starts empty and reports revision 0", () => {
    const search = new SearchStore();
    expect(search.getIndex().size()).toBe(0);
    expect(search.getRevision()).toBe(0);
  });

  it("hydrates from persisted events", async () => {
    const { storage, commands } = await setup();
    await commands.save("https://example.com/rust-ownership", { title: "Rust ownership" });
    await commands.save("https://example.com/python-typing", { title: "Python typing" });

    const fresh = new SearchStore();
    await fresh.hydrate(storage);
    const hits = fresh.getIndex().search("rust");
    expect(hits.length).toBe(1);
  });

  it("applies live events from VaultCommands and bumps revision", async () => {
    const { commands, search } = await setup();
    const before = search.getRevision();
    await commands.save("https://example.com/post", { title: "TDD discipline" });
    expect(search.getRevision()).toBeGreaterThan(before);
    expect(search.getIndex().search("tdd").length).toBe(1);
  });

  it("notifies subscribers on every apply", async () => {
    const { commands, search } = await setup();
    let notified = 0;
    search.subscribe(() => {
      notified += 1;
    });
    await commands.save("https://example.com/a", { title: "A" });
    await commands.save("https://example.com/b", { title: "B" });
    expect(notified).toBeGreaterThanOrEqual(2);
  });
});
