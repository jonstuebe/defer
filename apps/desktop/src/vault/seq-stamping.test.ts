import { describe, expect, it, vi } from "vitest";
import { ready } from "@defer/core/crypto";
import { PendingEventQueue } from "@defer/core/pending-event-queue";
import { OutboundFlush } from "@defer/core/outbound-flush";
import { RelayClient } from "@defer/core/relay-client";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { VaultProjectionStore } from "./projection-store.js";
import { VaultCommands } from "./commands.js";
import { SqlitePendingQueueStorage } from "./pending-queue-adapter.js";
import { decodePendingEvent } from "./wire-codec.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL, { now: () => 1_700_000_000_000 });
  await storage.init();
  const projection = new VaultProjectionStore(storage);
  const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));
  return { storage, projection, pendingQueue };
}

describe("desktop ↔ OutboundFlush ↔ stampEventSeq integration", () => {
  it("save → flush → events.seq is stamped with the relay-assigned seq", async () => {
    const { storage, projection, pendingQueue } = await setup();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ assigned: [42] }));
    const client = new RelayClient({
      baseUrl: "https://relay.example",
      vaultIdBase64Url: "vaultAAAAAAAAAAAAAAAAA",
      bearerToken: "bearerAAAAAAAAAAAAAAAA",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const flush = new OutboundFlush({
      queue: pendingQueue,
      client,
      decode: decodePendingEvent,
      async onSeqAssigned(assignments) {
        for (const a of assignments) {
          await storage.stampEventSeq(a.deviceId, a.clientNonce, a.seq);
        }
      },
    });

    const commands = new VaultCommands({
      storage,
      projection,
      pendingQueue,
      deviceId: "device-AAAAAAAAAAAAA",
      now: () => 1_700_000_000_000,
    });

    await commands.save("https://example.com/article");

    // Before flush: row exists with seq=NULL.
    const before = await storage.allEvents();
    expect(before).toHaveLength(1);
    expect(before[0]?.seq).toBeNull();

    await flush.flush();

    const after = await storage.allEvents();
    expect(after).toHaveLength(1);
    expect(after[0]?.seq).toBe(42);
  });

  it("does not throw when stamping an event that no longer exists (e.g., post-wipe)", async () => {
    const { storage } = await setup();
    // No row matches — stampEventSeq is a no-op rather than an error.
    await expect(
      storage.stampEventSeq("nonexistent-device", "nonexistent-nonce", 99),
    ).resolves.toBeUndefined();
  });
});
