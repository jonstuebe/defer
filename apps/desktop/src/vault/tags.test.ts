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
  const storage = new SqliteStorage(SQL);
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
  await commands.save("https://example.com/a");
  await commands.save("https://example.com/b");
  const items = projection.getItemsSortedBySavedAtDesc();
  return { commands, projection, items };
}

describe("VaultCommands.tag / untag", () => {
  it("adds and removes a tag from a single item", async () => {
    const { commands, projection, items } = await setup();
    const target = items[0];
    if (!target) throw new Error("missing item");
    await commands.tag(target.id, "rust");
    expect(projection.getState().items.get(target.id)?.tags).toEqual(["rust"]);

    await commands.untag(target.id, "rust");
    expect(projection.getState().items.get(target.id)?.tags).toEqual([]);
  });

  it("treats `Rust` and `rust` as distinct tags (case-sensitive per CONTEXT.md)", async () => {
    const { commands, projection, items } = await setup();
    const target = items[0];
    if (!target) throw new Error("missing item");
    await commands.tag(target.id, "Rust");
    await commands.tag(target.id, "rust");
    const tags = projection.getState().items.get(target.id)?.tags ?? [];
    expect(tags).toContain("Rust");
    expect(tags).toContain("rust");
    expect(tags.length).toBe(2);
  });

  it("trims whitespace and rejects empty tags", async () => {
    const { commands, projection, items } = await setup();
    const target = items[0];
    if (!target) throw new Error("missing item");
    await commands.tag(target.id, "  spaced  ");
    expect(projection.getState().items.get(target.id)?.tags).toEqual(["spaced"]);

    await expect(commands.tag(target.id, "   ")).rejects.toThrow(/non-empty/);
  });

  it("populates the projection's vault-wide tags set across items", async () => {
    const { commands, projection, items } = await setup();
    const [a, b] = items;
    if (!a || !b) throw new Error("missing items");
    await commands.tag(a.id, "alpha");
    await commands.tag(b.id, "beta");
    const tags = [...projection.getState().tags].sort();
    expect(tags).toEqual(["alpha", "beta"]);
  });
});
