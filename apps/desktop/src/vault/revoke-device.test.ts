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
  return { storage, projection, pendingQueue, commands };
}

describe("VaultCommands.revokeDevice", () => {
  it("emits DeviceRevoked and persists to the queue + events table", async () => {
    const { commands, storage, pendingQueue } = await setup();
    await commands.revokeDevice("device-BBBBBBBBBBBBB");

    const events = await storage.allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("DeviceRevoked");

    const pending = await pendingQueue.peek();
    expect(pending).toHaveLength(1);
    const decoded = JSON.parse(new TextDecoder().decode(pending[0]?.event));
    expect(decoded.type).toBe("DeviceRevoked");
    expect(decoded.data.deviceId).toBe("device-BBBBBBBBBBBBB");
  });
});
