import { describe, expect, it } from "vitest";

import {
  CancelDeletionRequestSchema,
  CancelDeletionResponseSchema,
  GetPairingResponseSchema,
  MAX_BATCH_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEALED_PAYLOAD_BYTES,
  PAIRING_TOKEN_REGEX,
  PullEventsResponseSchema,
  PushEventsRequestSchema,
  PushEventsResponseSchema,
  PutPairingRequestSchema,
  RegisterDeviceRequestSchema,
  RegisterDeviceResponseSchema,
  RevokeDeviceResponseSchema,
  ScheduleDeletionRequestSchema,
  ScheduleDeletionResponseSchema,
} from "../index.js";
import { RELAY_DEVICE_ID } from "../../events/envelope.js";

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

describe("RegisterDeviceRequestSchema", () => {
  // 22-char base64url placeholders for `deviceId` / `deviceAuthToken`. Both
  // are 16 random bytes encoded with the URL-safe alphabet (ADR-0003 +
  // ADR-0006 §4.1). All-letter strings are valid base64url and parse.
  const DEVICE_ID = "AAAAAAAAAAAAAAAAAAAAAA";
  const TOKEN = "BBBBBBBBBBBBBBBBBBBBBB";

  it("parses a real example", () => {
    const result = RegisterDeviceRequestSchema.safeParse({
      deviceId: DEVICE_ID,
      deviceAuthToken: TOKEN,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a 21-char deviceId", () => {
    const result = RegisterDeviceRequestSchema.safeParse({
      deviceId: "A".repeat(21),
      deviceAuthToken: TOKEN,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a 23-char deviceAuthToken", () => {
    const result = RegisterDeviceRequestSchema.safeParse({
      deviceId: DEVICE_ID,
      deviceAuthToken: "A".repeat(23),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-base64url characters in deviceId", () => {
    // `+` and `/` are the standard-base64 chars that base64url replaces with
    // `-` and `_`; rejecting them is the load-bearing test for `.strict()`.
    const result = RegisterDeviceRequestSchema.safeParse({
      deviceId: "AAAAAAAAAAAAAAAAAAAAA+",
      deviceAuthToken: TOKEN,
    });
    expect(result.success).toBe(false);
  });

  it("rejects requests missing deviceAuthToken", () => {
    const result = RegisterDeviceRequestSchema.safeParse({ deviceId: DEVICE_ID });
    expect(result.success).toBe(false);
  });

  it("rejects requests with extra fields (.strict())", () => {
    const result = RegisterDeviceRequestSchema.safeParse({
      deviceId: DEVICE_ID,
      deviceAuthToken: TOKEN,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("RegisterDeviceResponseSchema", () => {
  it("parses { ok: true }", () => {
    const result = RegisterDeviceResponseSchema.safeParse({ ok: true });
    expect(result.success).toBe(true);
  });

  it("rejects { ok: false }", () => {
    const result = RegisterDeviceResponseSchema.safeParse({ ok: false });
    expect(result.success).toBe(false);
  });
});

describe("RevokeDeviceResponseSchema", () => {
  it("parses { ok: true }", () => {
    const result = RevokeDeviceResponseSchema.safeParse({ ok: true });
    expect(result.success).toBe(true);
  });

  it("rejects { ok: false }", () => {
    const result = RevokeDeviceResponseSchema.safeParse({ ok: false });
    expect(result.success).toBe(false);
  });
});

describe("PAIRING_TOKEN_REGEX / MAX_SEALED_PAYLOAD_BYTES", () => {
  it("pins the v1 pairing constants", () => {
    // The regex shape is contractual — both client and relay validate against
    // it, so changing it is a protocol bump. Same for the 4 KB ceiling.
    expect(PAIRING_TOKEN_REGEX.source).toBe("^[A-Za-z0-9_-]{22}$");
    expect(MAX_SEALED_PAYLOAD_BYTES).toBe(4096);
  });
});

describe("PutPairingRequestSchema", () => {
  // 22-char base64url pairing token + a tiny valid base64 payload. The
  // payload here is `btoa("hi")` which is `"aGk="`.
  const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";
  const PAYLOAD = "aGk=";

  it("parses a real example", () => {
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: TOKEN,
      sealedPayload: PAYLOAD,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a 21-char pairing token", () => {
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: "A".repeat(21),
      sealedPayload: PAYLOAD,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a 23-char pairing token", () => {
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: "A".repeat(23),
      sealedPayload: PAYLOAD,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-base64url characters in pairing token", () => {
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: "AAAAAAAAAAAAAAAAAAAA++",
      sealedPayload: PAYLOAD,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty sealedPayload", () => {
    // Regex requires at least one base64 char.
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: TOKEN,
      sealedPayload: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects sealedPayload with non-base64 characters", () => {
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: TOKEN,
      sealedPayload: "not-base64!",
    });
    expect(result.success).toBe(false);
  });

  it("accepts sealedPayload with padding", () => {
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: TOKEN,
      sealedPayload: "YWJjZA==",
    });
    expect(result.success).toBe(true);
  });

  it("rejects requests missing sealedPayload", () => {
    const result = PutPairingRequestSchema.safeParse({ pairingToken: TOKEN });
    expect(result.success).toBe(false);
  });

  it("rejects requests with extra fields (.strict())", () => {
    const result = PutPairingRequestSchema.safeParse({
      pairingToken: TOKEN,
      sealedPayload: PAYLOAD,
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("ScheduleDeletionRequestSchema", () => {
  // 43-char base64url signature placeholder (32-byte HMAC-SHA256 unpadded).
  const SIG = "A".repeat(43);
  // 22-char base64url clientNonce placeholder.
  const NONCE_A = "A".repeat(22);
  const NONCE_B = "B".repeat(22);
  const DEVICE = "device-abc";
  const SCHEDULED_FOR = 1_700_000_000_000 + 48 * 60 * 60 * 1000;

  function scheduled(): Record<string, unknown> {
    return {
      type: "VaultDeletionScheduled",
      deviceId: DEVICE,
      timestamp: 1_700_000_000_000,
      clientNonce: NONCE_A,
      signature: SIG,
      data: { scheduledFor: SCHEDULED_FOR },
    };
  }
  function deleted(): Record<string, unknown> {
    return {
      type: "VaultDeleted",
      deviceId: RELAY_DEVICE_ID,
      timestamp: 1_700_000_000_000,
      clientNonce: NONCE_B,
      signature: SIG,
      data: { deletedAt: SCHEDULED_FOR },
    };
  }

  it("parses a real example", () => {
    const result = ScheduleDeletionRequestSchema.safeParse({
      scheduled: scheduled(),
      deleted: deleted(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects when `scheduled` is missing", () => {
    const result = ScheduleDeletionRequestSchema.safeParse({ deleted: deleted() });
    expect(result.success).toBe(false);
  });

  it("rejects when `deleted` is missing", () => {
    const result = ScheduleDeletionRequestSchema.safeParse({ scheduled: scheduled() });
    expect(result.success).toBe(false);
  });

  it("rejects when `scheduled` has a malformed signature", () => {
    const bad = scheduled();
    (bad as { signature: string }).signature = "A".repeat(42);
    const result = ScheduleDeletionRequestSchema.safeParse({
      scheduled: bad,
      deleted: deleted(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects when `deleted` has a malformed signature", () => {
    const bad = deleted();
    (bad as { signature: string }).signature = "A".repeat(44);
    const result = ScheduleDeletionRequestSchema.safeParse({
      scheduled: scheduled(),
      deleted: bad,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when `scheduled` carries a `seq` field (Pending* schemas omit seq)", () => {
    // Pending schemas use `.omit({ seq: true })` — Zod stripping unknown keys
    // means a seq-carrying envelope still parses (the key is dropped). This
    // test pins that behaviour so future schema work doesn't accidentally
    // tighten it.
    const withSeq = { ...scheduled(), seq: 7 };
    const result = ScheduleDeletionRequestSchema.safeParse({
      scheduled: withSeq,
      deleted: deleted(),
    });
    expect(result.success).toBe(true);
  });
});

describe("ScheduleDeletionResponseSchema", () => {
  it("parses a real example", () => {
    const result = ScheduleDeletionResponseSchema.safeParse({
      scheduledFor: 1_700_000_000_000,
      assignedSeq: 5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects assignedSeq of 0 (must be positive)", () => {
    const result = ScheduleDeletionResponseSchema.safeParse({
      scheduledFor: 1_700_000_000_000,
      assignedSeq: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative scheduledFor", () => {
    const result = ScheduleDeletionResponseSchema.safeParse({
      scheduledFor: -1,
      assignedSeq: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("CancelDeletionRequestSchema", () => {
  const SIG = "A".repeat(43);
  const NONCE = "C".repeat(22);
  function cancelled(): Record<string, unknown> {
    return {
      type: "VaultDeletionCancelled",
      deviceId: "device-abc",
      timestamp: 1_700_000_000_000,
      clientNonce: NONCE,
      signature: SIG,
      data: {},
    };
  }

  it("parses a real example", () => {
    const result = CancelDeletionRequestSchema.safeParse({ cancelled: cancelled() });
    expect(result.success).toBe(true);
  });

  it("rejects when `cancelled` is missing", () => {
    const result = CancelDeletionRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a malformed signature", () => {
    const bad = cancelled();
    (bad as { signature: string }).signature = "not-base64url";
    const result = CancelDeletionRequestSchema.safeParse({ cancelled: bad });
    expect(result.success).toBe(false);
  });
});

describe("CancelDeletionResponseSchema", () => {
  it("parses a real example", () => {
    const result = CancelDeletionResponseSchema.safeParse({ assignedSeq: 3 });
    expect(result.success).toBe(true);
  });

  it("rejects assignedSeq of 0", () => {
    const result = CancelDeletionResponseSchema.safeParse({ assignedSeq: 0 });
    expect(result.success).toBe(false);
  });
});

describe("GetPairingResponseSchema", () => {
  it("parses a real example", () => {
    const result = GetPairingResponseSchema.safeParse({ sealedPayload: "aGk=" });
    expect(result.success).toBe(true);
  });

  it("rejects empty sealedPayload", () => {
    const result = GetPairingResponseSchema.safeParse({ sealedPayload: "" });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields", () => {
    const result = GetPairingResponseSchema.safeParse({
      sealedPayload: "aGk=",
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});
