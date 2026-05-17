import { describe, expect, it } from "vitest";

import {
  MAX_BATCH_SIZE,
  MAX_PAGE_SIZE,
  PullEventsResponseSchema,
  PushEventsRequestSchema,
  PushEventsResponseSchema,
} from "../index.js";

// 22-char base64url placeholder for the 16-byte `clientNonce` (ADR-0006 §4.1).
const CLIENT_NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

function pendingItemSaved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ItemSaved",
    deviceId: "device-abc",
    timestamp: 1_700_000_000_000,
    clientNonce: CLIENT_NONCE,
    data: {
      itemId: "item-1",
      url: "https://example.com/article",
      canonicalUrl: "https://example.com/article",
      title: "An article",
      savedAt: 1_700_000_000_000,
    },
    ...overrides,
  };
}

function itemSaved(seq: number): Record<string, unknown> {
  return {
    type: "ItemSaved",
    seq,
    deviceId: "device-abc",
    timestamp: 1_700_000_000_000,
    clientNonce: CLIENT_NONCE,
    data: {
      itemId: `item-${seq}`,
      url: "https://example.com/article",
      canonicalUrl: "https://example.com/article",
      title: "An article",
      savedAt: 1_700_000_000_000,
    },
  };
}

describe("MAX_BATCH_SIZE / MAX_PAGE_SIZE", () => {
  it("pins the v1 batch and page caps", () => {
    expect(MAX_BATCH_SIZE).toBe(100);
    expect(MAX_PAGE_SIZE).toBe(1000);
  });
});

describe("PushEventsRequestSchema", () => {
  it("parses a real single-event batch", () => {
    const result = PushEventsRequestSchema.safeParse({ events: [pendingItemSaved()] });
    expect(result.success).toBe(true);
  });

  it("parses a real multi-event batch", () => {
    const result = PushEventsRequestSchema.safeParse({
      events: [
        pendingItemSaved({ clientNonce: "BBBBBBBBBBBBBBBBBBBBBB" }),
        pendingItemSaved({ clientNonce: "CCCCCCCCCCCCCCCCCCCCCC" }),
        pendingItemSaved({ clientNonce: "DDDDDDDDDDDDDDDDDDDDDD" }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty batches", () => {
    const result = PushEventsRequestSchema.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });

  it("rejects oversized batches (> MAX_BATCH_SIZE)", () => {
    const events = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) =>
      pendingItemSaved({
        clientNonce: `${i.toString().padStart(22, "A").slice(-22)}`,
      }),
    );
    const result = PushEventsRequestSchema.safeParse({ events });
    expect(result.success).toBe(false);
  });

  it("accepts a batch of exactly MAX_BATCH_SIZE", () => {
    const events = Array.from({ length: MAX_BATCH_SIZE }, (_, i) =>
      pendingItemSaved({
        clientNonce: `${i.toString().padStart(22, "A").slice(-22)}`,
      }),
    );
    const result = PushEventsRequestSchema.safeParse({ events });
    expect(result.success).toBe(true);
  });

  it("rejects events with a malformed clientNonce", () => {
    const result = PushEventsRequestSchema.safeParse({
      events: [pendingItemSaved({ clientNonce: "too-short" })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects events missing clientNonce entirely", () => {
    const event = pendingItemSaved();
    delete (event as { clientNonce?: unknown }).clientNonce;
    const result = PushEventsRequestSchema.safeParse({ events: [event] });
    expect(result.success).toBe(false);
  });

  it("strips `seq` from pending envelopes (forward-compat: extra keys are dropped)", () => {
    // PendingEventSchema is `.omit({ seq: true })` of the inbound schema, and
    // Zod strips unknown keys by default — a fully-sequenced envelope handed
    // to the push request schema parses (with seq dropped). This is the
    // documented behaviour in events/index.ts; the test locks it in.
    const result = PushEventsRequestSchema.safeParse({ events: [itemSaved(42)] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.events[0] as { seq?: number }).seq).toBeUndefined();
    }
  });
});

describe("PushEventsResponseSchema", () => {
  it("parses a real response", () => {
    const result = PushEventsResponseSchema.safeParse({ assigned: [1, 2, 3] });
    expect(result.success).toBe(true);
  });

  it("rejects non-integer seq numbers", () => {
    const result = PushEventsResponseSchema.safeParse({ assigned: [1.5] });
    expect(result.success).toBe(false);
  });

  it("rejects negative seq numbers", () => {
    const result = PushEventsResponseSchema.safeParse({ assigned: [-1] });
    expect(result.success).toBe(false);
  });
});

describe("PullEventsResponseSchema", () => {
  it("parses a real response with nextSince null", () => {
    const result = PullEventsResponseSchema.safeParse({
      events: [itemSaved(1), itemSaved(2)],
      nextSince: null,
    });
    expect(result.success).toBe(true);
  });

  it("parses a real response with nextSince populated", () => {
    const result = PullEventsResponseSchema.safeParse({
      events: [itemSaved(1)],
      nextSince: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects responses missing nextSince", () => {
    const result = PullEventsResponseSchema.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });

  it("rejects empty events with a non-null nextSince still parses (server contract is non-null iff capped, not iff non-empty)", () => {
    // Schema doesn't enforce semantics; the relay does. Both forms parse.
    const result = PullEventsResponseSchema.safeParse({ events: [], nextSince: 7 });
    expect(result.success).toBe(true);
  });
});
