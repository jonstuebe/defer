import { describe, expect, it, vi } from "vitest";
import { RelayClient } from "@defer/core/relay-client";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { VaultProjectionStore } from "./projection-store.js";
import { makeInboundReplay, SETTING_INBOUND_CURSOR, InboundScheduler } from "./inbound.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function setup() {
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL, { now: () => 1_700_000_000_000 });
  await storage.init();
  const projection = new VaultProjectionStore(storage);
  return { storage, projection };
}

function makeEvent(seq: number, itemId: string, clientNonce: string) {
  return {
    type: "ItemSaved",
    seq,
    deviceId: "deviceAAAAAAAAAAAAAAA",
    timestamp: 1_700_000_000_000,
    clientNonce,
    data: {
      itemId,
      url: `https://example.com/${itemId}`,
      canonicalUrl: `https://example.com/${itemId}`,
      title: "",
      savedAt: 1_700_000_000_000,
    },
  };
}

describe("desktop inbound wiring", () => {
  it("pulls events, applies via projection, and persists cursor in settings", async () => {
    const { storage, projection } = await setup();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        events: [makeEvent(1, "item-1", "nonceAAAAAAAAAAAAAAAAA")],
        nextSince: null,
      }),
    );
    const client = new RelayClient({
      baseUrl: "https://relay.example",
      vaultIdBase64Url: "vaultAAAAAAAAAAAAAAAAA",
      bearerToken: "bearerAAAAAAAAAAAAAAAA",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const replay = makeInboundReplay({ client, storage, projection });

    const result = await replay.pull();

    expect(result.applied).toBe(1);
    expect(projection.getState().items.size).toBe(1);
    expect(await storage.getSetting(SETTING_INBOUND_CURSOR)).toBe("1");

    // Persisted to events table too — hydrate from a fresh projection
    // should produce the same state.
    const fresh = new VaultProjectionStore(storage);
    await fresh.hydrate();
    expect(fresh.getState().items.size).toBe(1);
  });

  it("resumes from a previously-written cursor", async () => {
    const { storage, projection } = await setup();
    await storage.setSetting(SETTING_INBOUND_CURSOR, "42");
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ events: [], nextSince: null }));
    const client = new RelayClient({
      baseUrl: "https://relay.example",
      vaultIdBase64Url: "vaultAAAAAAAAAAAAAAAAA",
      bearerToken: "bearerAAAAAAAAAAAAAAAA",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const replay = makeInboundReplay({ client, storage, projection });
    await replay.pull();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("since=42");
  });

  it("InboundScheduler.triggerNow coalesces concurrent calls", async () => {
    let resolveFirst!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ events: [], nextSince: null }));

    const { storage, projection } = await setup();
    const client = new RelayClient({
      baseUrl: "https://relay.example",
      vaultIdBase64Url: "vaultAAAAAAAAAAAAAAAAA",
      bearerToken: "bearerAAAAAAAAAAAAAAAA",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const replay = makeInboundReplay({ client, storage, projection });
    const scheduler = new InboundScheduler(replay, 60_000);

    // Three triggers — only one runs in-flight; trailing ones coalesce.
    scheduler.triggerNow();
    scheduler.triggerNow();
    scheduler.triggerNow();

    // readCursor + projection setup happen on microtasks before fetch is
    // called, so we drain the queue once before asserting on the
    // in-flight network call.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(jsonResponse({ events: [], nextSince: null }));
    // The trailing trigger fires once the in-flight pull resolves.
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});
