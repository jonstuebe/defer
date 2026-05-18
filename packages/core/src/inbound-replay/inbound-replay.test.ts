import { describe, expect, it, vi } from "vitest";

import { InboundReplay } from "./inbound-replay.js";
import { RelayClient } from "../relay-client/index.js";
import type { Event } from "../events/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeEvent(seq: number, clientNonce: string, itemId: string): Event {
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

function makeReplay(fetchMock: ReturnType<typeof vi.fn>) {
  const client = new RelayClient({
    baseUrl: "https://relay.example",
    vaultIdBase64Url: "vaultAAAAAAAAAAAAAAAAA",
    bearerToken: "bearerAAAAAAAAAAAAAAAA",
    fetch: fetchMock as unknown as typeof globalThis.fetch,
  });
  let cursor = 0;
  const readCursor = vi.fn(async () => cursor);
  const writeCursor = vi.fn(async (next: number) => {
    cursor = next;
  });
  const onEvent = vi.fn<(event: Event) => Promise<void>>(async () => {});
  const onSkipped = vi.fn();
  const replay = new InboundReplay({ client, readCursor, writeCursor, onEvent, onSkipped });
  return {
    replay,
    readCursor,
    writeCursor,
    onEvent,
    onSkipped,
    getCursor: () => cursor,
  };
}

describe("InboundReplay.pull", () => {
  it("returns { applied: 0 } when the relay has nothing new", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ events: [], nextSince: null }));
    const { replay, writeCursor } = makeReplay(fetchMock);
    const result = await replay.pull();
    expect(result.applied).toBe(0);
    expect(writeCursor).not.toHaveBeenCalled();
  });

  it("applies events in order and advances the cursor to the highest seq", async () => {
    const e1 = makeEvent(1, "nonceAAAAAAAAAAAAAAAAA", "item-1");
    const e2 = makeEvent(2, "nonceBBBBBBBBBBBBBBBBB", "item-2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ events: [e1, e2], nextSince: null }));
    const { replay, onEvent, getCursor } = makeReplay(fetchMock);

    const result = await replay.pull();

    expect(result.applied).toBe(2);
    expect(getCursor()).toBe(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0]![0].seq).toBe(1);
    expect(onEvent.mock.calls[1]![0].seq).toBe(2);
  });

  it("follows nextSince across paged responses", async () => {
    const e1 = makeEvent(1, "nonceAAAAAAAAAAAAAAAAA", "item-1");
    const e2 = makeEvent(2, "nonceBBBBBBBBBBBBBBBBB", "item-2");
    const e3 = makeEvent(3, "nonceCCCCCCCCCCCCCCCCC", "item-3");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ events: [e1, e2], nextSince: 2 }))
      .mockResolvedValueOnce(jsonResponse({ events: [e3], nextSince: null }));
    const { replay, getCursor } = makeReplay(fetchMock);

    const result = await replay.pull();

    expect(result.applied).toBe(3);
    expect(getCursor()).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips events that fail schema validation but advances past their seq", async () => {
    const e1 = makeEvent(1, "nonceAAAAAAAAAAAAAAAAA", "item-1");
    const broken = { type: "ItemSaved", seq: 2, deviceId: "x" }; // missing required fields
    const e3 = makeEvent(3, "nonceCCCCCCCCCCCCCCCCC", "item-3");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ events: [e1, broken, e3], nextSince: null }));
    const { replay, onSkipped, getCursor, onEvent } = makeReplay(fetchMock);

    const result = await replay.pull();

    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(1);
    expect(onSkipped).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(getCursor()).toBe(3);
  });

  it("aborts the pull and leaves the cursor unchanged when onEvent throws", async () => {
    const e1 = makeEvent(1, "nonceAAAAAAAAAAAAAAAAA", "item-1");
    const e2 = makeEvent(2, "nonceBBBBBBBBBBBBBBBBB", "item-2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ events: [e1, e2], nextSince: null }));
    const { replay, getCursor, onEvent, writeCursor } = makeReplay(fetchMock);

    onEvent.mockImplementation(async (event) => {
      if (event.seq === 2) throw new Error("storage write failed");
    });

    await expect(replay.pull()).rejects.toThrow(/storage write failed/);
    // Cursor was never written this call — re-pulling will return e1+e2 again
    // and the reducer will idempotently no-op on e1 (per ADR-0002 §"replay-safe").
    expect(writeCursor).not.toHaveBeenCalled();
    expect(getCursor()).toBe(0);
  });
});
