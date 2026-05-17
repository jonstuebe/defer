import { describe, expect, it, vi } from "vitest";

import { OutboundFlush, type SeqAssignment } from "./outbound-flush.js";
import { InMemoryStoragePort, PendingEventQueue } from "../pending-event-queue/index.js";
import { RelayClient, RelayError } from "../relay-client/index.js";
import type { PendingEvent } from "../events/index.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFixtureEvent(itemId: string, clientNonce: string): PendingEvent {
  return {
    type: "ItemSaved",
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

async function makeQueue(initial: PendingEvent[] = []) {
  const queue = new PendingEventQueue(new InMemoryStoragePort());
  for (const event of initial) {
    await queue.enqueue(new TextEncoder().encode(JSON.stringify(event)));
  }
  return queue;
}

function makeFlush(fetchMock: FetchMock, queue: PendingEventQueue) {
  const onSeqAssigned = vi.fn<(assignments: SeqAssignment[]) => Promise<void>>(async () => {});
  const client = new RelayClient({
    baseUrl: "https://relay.example",
    vaultIdBase64Url: "vaultAAAAAAAAAAAAAAAAA",
    bearerToken: "bearerAAAAAAAAAAAAAAAA",
    fetch: fetchMock as unknown as typeof globalThis.fetch,
  });
  const flush = new OutboundFlush({
    queue,
    client,
    onSeqAssigned,
    decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as PendingEvent,
  });
  return { flush, onSeqAssigned, client };
}

describe("OutboundFlush.flush", () => {
  it("returns { flushed: 0 } on an empty queue without hitting the network", async () => {
    const queue = await makeQueue();
    const fetchMock = vi.fn();
    const { flush } = makeFlush(fetchMock, queue);
    const result = await flush.flush();
    expect(result).toEqual({ flushed: 0, failed: 0, duplicates: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drains the queue + calls onSeqAssigned with relay seqs in order", async () => {
    const e1 = makeFixtureEvent("item-1", "nonceAAAAAAAAAAAAAAAAA");
    const e2 = makeFixtureEvent("item-2", "nonceBBBBBBBBBBBBBBBBB");
    const queue = await makeQueue([e1, e2]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ assigned: [7, 8] }));
    const { flush, onSeqAssigned } = makeFlush(fetchMock, queue);

    const result = await flush.flush();

    expect(result.flushed).toBe(2);
    expect(result.failed).toBe(0);
    expect(onSeqAssigned).toHaveBeenCalledOnce();
    const assignments = onSeqAssigned.mock.calls[0]![0];
    expect(assignments).toEqual([
      { clientNonce: e1.clientNonce, deviceId: e1.deviceId, seq: 7 },
      { clientNonce: e2.clientNonce, deviceId: e2.deviceId, seq: 8 },
    ]);
    expect(await queue.size()).toBe(0);
  });

  it("treats DUPLICATE_CLIENT_NONCE as already-synced and drops the entries", async () => {
    const e1 = makeFixtureEvent("item-1", "nonceCCCCCCCCCCCCCCCCC");
    const queue = await makeQueue([e1]);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "conflict",
          code: "DUPLICATE_CLIENT_NONCE",
          requestId: "01926bdb-c002-7000-8000-000000000002",
        },
        409,
      ),
    );
    const { flush, onSeqAssigned } = makeFlush(fetchMock, queue);

    const result = await flush.flush();

    expect(result.duplicates).toBe(1);
    expect(result.flushed).toBe(0);
    expect(onSeqAssigned).not.toHaveBeenCalled();
    expect(await queue.size()).toBe(0);
  });

  it("marks the batch failed and rethrows on a non-duplicate relay error", async () => {
    const e1 = makeFixtureEvent("item-1", "nonceDDDDDDDDDDDDDDDDD");
    const queue = await makeQueue([e1]);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: "rate_limited",
          code: "RATE_LIMITED",
          requestId: "01926bdb-c003-7000-8000-000000000003",
        },
        429,
      ),
    );
    const { flush } = makeFlush(fetchMock, queue);

    await expect(flush.flush()).rejects.toBeInstanceOf(RelayError);
    expect(await queue.size()).toBe(1);

    const pending = await queue.peek();
    expect(pending[0]?.status).toBe("failed");
    expect(pending[0]?.attemptCount).toBe(1);
  });

  it("propagates transport errors and marks failed", async () => {
    const e1 = makeFixtureEvent("item-1", "nonceEEEEEEEEEEEEEEEEE");
    const queue = await makeQueue([e1]);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    const { flush } = makeFlush(fetchMock, queue);

    await expect(flush.flush()).rejects.toThrow(/offline/);
    expect(await queue.size()).toBe(1);
  });
});
