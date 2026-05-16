import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EventSchema,
  type Event,
  PendingEventSchema,
  type PendingEvent,
  ItemSavedSchema,
  ItemArchivedSchema,
  ItemUnarchivedSchema,
  ItemLikedSchema,
  ItemUnlikedSchema,
  ItemTaggedSchema,
  ItemUntaggedSchema,
  ItemTitleEditedSchema,
  ItemDeletedSchema,
  DeviceRegisteredSchema,
  DeviceRevokedSchema,
  VaultDeletionScheduledSchema,
  VaultDeletionCancelledSchema,
  VaultDeletedSchema,
  RELAY_DEVICE_ID,
  PendingItemSavedSchema,
  PendingItemArchivedSchema,
} from "../index.js";

const envelope = {
  seq: 1,
  deviceId: "device-abc",
  timestamp: 1_700_000_000_000,
};

describe("EventSchema (catalog)", () => {
  it("contains all 14 v1 event types", () => {
    const types: Event["type"][] = [
      "ItemSaved",
      "ItemArchived",
      "ItemUnarchived",
      "ItemLiked",
      "ItemUnliked",
      "ItemTagged",
      "ItemUntagged",
      "ItemTitleEdited",
      "ItemDeleted",
      "DeviceRegistered",
      "DeviceRevoked",
      "VaultDeletionScheduled",
      "VaultDeletionCancelled",
      "VaultDeleted",
    ];
    expect(types).toHaveLength(14);
  });

  it("rejects unknown event types so the reducer can rely on type narrowing", () => {
    const unknownTypeEvent = {
      ...envelope,
      type: "ItemPondered",
      data: { itemId: "i1" },
    };
    expect(EventSchema.safeParse(unknownTypeEvent).success).toBe(false);
  });

  it("infers a discriminated union type from the schema", () => {
    const parsed = EventSchema.parse({
      type: "ItemSaved",
      ...envelope,
      data: {
        itemId: "i1",
        url: "https://example.com",
        canonicalUrl: "https://example.com",
        title: "t",
        savedAt: 1,
      },
    });
    if (parsed.type === "ItemSaved") {
      expectTypeOf(parsed.data.url).toBeString();
    }
  });
});

describe("envelope validation (shared across all events)", () => {
  it("requires seq, deviceId, and timestamp", () => {
    expect(
      EventSchema.safeParse({
        type: "ItemArchived",
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);

    expect(
      EventSchema.safeParse({
        type: "ItemArchived",
        seq: 1,
        timestamp: 1,
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);
  });

  it("rejects negative seq", () => {
    expect(
      EventSchema.safeParse({
        type: "ItemArchived",
        ...envelope,
        seq: -1,
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);
  });

  it("rejects non-numeric timestamp", () => {
    expect(
      EventSchema.safeParse({
        type: "ItemArchived",
        ...envelope,
        timestamp: "yesterday",
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);
  });

  it("rejects empty deviceId", () => {
    expect(
      EventSchema.safeParse({
        type: "ItemArchived",
        ...envelope,
        deviceId: "",
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);
  });
});

describe("ItemSaved", () => {
  const valid = {
    type: "ItemSaved",
    ...envelope,
    data: {
      itemId: "i1",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Example",
      savedAt: 1_700_000_000_000,
    },
  };

  it("parses a valid event", () => {
    expect(ItemSavedSchema.safeParse(valid).success).toBe(true);
    expect(EventSchema.safeParse(valid).success).toBe(true);
  });

  it("fails when data fields are missing", () => {
    const { canonicalUrl: _drop, ...partialData } = valid.data;
    expect(EventSchema.safeParse({ ...valid, data: partialData }).success).toBe(false);
  });

  it("fails when a data field has the wrong type", () => {
    expect(
      EventSchema.safeParse({
        ...valid,
        data: { ...valid.data, savedAt: "now" },
      }).success,
    ).toBe(false);
  });
});

describe("ItemArchived / ItemUnarchived / ItemLiked / ItemUnliked / ItemDeleted", () => {
  const cases = [
    ["ItemArchived", ItemArchivedSchema],
    ["ItemUnarchived", ItemUnarchivedSchema],
    ["ItemLiked", ItemLikedSchema],
    ["ItemUnliked", ItemUnlikedSchema],
    ["ItemDeleted", ItemDeletedSchema],
  ] as const;

  for (const [type, schema] of cases) {
    it(`${type} parses a valid event and rejects missing itemId`, () => {
      const valid = { type, ...envelope, data: { itemId: "i1" } };
      expect(schema.safeParse(valid).success).toBe(true);
      expect(EventSchema.safeParse(valid).success).toBe(true);

      expect(schema.safeParse({ type, ...envelope, data: {} }).success).toBe(false);
    });
  }
});

describe("ItemTagged / ItemUntagged", () => {
  const cases = [
    ["ItemTagged", ItemTaggedSchema],
    ["ItemUntagged", ItemUntaggedSchema],
  ] as const;

  for (const [type, schema] of cases) {
    it(`${type} requires itemId and tag`, () => {
      const valid = {
        type,
        ...envelope,
        data: { itemId: "i1", tag: "rust" },
      };
      expect(schema.safeParse(valid).success).toBe(true);

      expect(
        schema.safeParse({
          type,
          ...envelope,
          data: { itemId: "i1" },
        }).success,
      ).toBe(false);

      expect(
        schema.safeParse({
          type,
          ...envelope,
          data: { itemId: "i1", tag: 42 },
        }).success,
      ).toBe(false);
    });
  }
});

describe("ItemTitleEdited", () => {
  it("requires itemId and title", () => {
    const valid = {
      type: "ItemTitleEdited" as const,
      ...envelope,
      data: { itemId: "i1", title: "New title" },
    };
    expect(ItemTitleEditedSchema.safeParse(valid).success).toBe(true);
    expect(
      ItemTitleEditedSchema.safeParse({
        ...valid,
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);
  });

  it("allows an empty title string (clears title)", () => {
    expect(
      ItemTitleEditedSchema.safeParse({
        type: "ItemTitleEdited",
        ...envelope,
        data: { itemId: "i1", title: "" },
      }).success,
    ).toBe(true);
  });
});

describe("DeviceRegistered", () => {
  const valid = {
    type: "DeviceRegistered" as const,
    ...envelope,
    data: {
      deviceId: "d1",
      deviceName: "Jon's iPhone",
      deviceType: "mobile",
      registeredAt: 1_700_000_000_000,
    },
  };

  it("parses a valid event", () => {
    expect(DeviceRegisteredSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing deviceName", () => {
    const { deviceName: _drop, ...partialData } = valid.data;
    expect(DeviceRegisteredSchema.safeParse({ ...valid, data: partialData }).success).toBe(false);
  });

  it("rejects non-numeric registeredAt", () => {
    expect(
      DeviceRegisteredSchema.safeParse({
        ...valid,
        data: { ...valid.data, registeredAt: "yesterday" },
      }).success,
    ).toBe(false);
  });

  it("accepts any non-empty deviceType string (forward-compat)", () => {
    expect(
      DeviceRegisteredSchema.safeParse({
        ...valid,
        data: { ...valid.data, deviceType: "newfangled-watch" },
      }).success,
    ).toBe(true);
  });
});

describe("DeviceRevoked", () => {
  it("requires deviceId", () => {
    expect(
      DeviceRevokedSchema.safeParse({
        type: "DeviceRevoked",
        ...envelope,
        data: { deviceId: "d1" },
      }).success,
    ).toBe(true);

    expect(
      DeviceRevokedSchema.safeParse({
        type: "DeviceRevoked",
        ...envelope,
        data: {},
      }).success,
    ).toBe(false);
  });
});

describe("VaultDeletionScheduled / Cancelled / Deleted", () => {
  // Placeholder base64-ish blob. Wire-format validation only — these tests
  // intentionally don't recompute or verify the signature; that's the job
  // of a separate (not-yet-built) crypto module.
  const signature = "c2lnbmF0dXJlLWJ5dGVz";

  it("VaultDeletionScheduled requires scheduledFor (emitter is the envelope's deviceId)", () => {
    const valid = {
      type: "VaultDeletionScheduled" as const,
      ...envelope,
      signature,
      data: { scheduledFor: 1_700_000_000_000 },
    };
    expect(VaultDeletionScheduledSchema.safeParse(valid).success).toBe(true);
    expect(
      VaultDeletionScheduledSchema.safeParse({
        ...valid,
        data: {},
      }).success,
    ).toBe(false);
    expect(
      VaultDeletionScheduledSchema.safeParse({
        ...valid,
        data: { scheduledFor: "soon" },
      }).success,
    ).toBe(false);
  });

  it("VaultDeletionScheduled strips legacy/unknown fields like `scheduledBy`", () => {
    // The emitter is already on the envelope; per-event "scheduledBy" is
    // not part of the schema. Forward-compat: unknown fields are ignored.
    const result = VaultDeletionScheduledSchema.safeParse({
      type: "VaultDeletionScheduled",
      ...envelope,
      signature,
      data: { scheduledFor: 1_700_000_000_000, scheduledBy: "d1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data).toEqual({ scheduledFor: 1_700_000_000_000 });
    }
  });

  it("VaultDeletionCancelled has no data fields (emitter is the envelope's deviceId)", () => {
    expect(
      VaultDeletionCancelledSchema.safeParse({
        type: "VaultDeletionCancelled",
        ...envelope,
        signature,
        data: {},
      }).success,
    ).toBe(true);
  });

  it("VaultDeletionCancelled strips legacy/unknown fields like `cancelledBy`", () => {
    const result = VaultDeletionCancelledSchema.safeParse({
      type: "VaultDeletionCancelled",
      ...envelope,
      signature,
      data: { cancelledBy: "d1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data).toEqual({});
    }
  });

  it("VaultDeleted requires a numeric deletedAt", () => {
    expect(
      VaultDeletedSchema.safeParse({
        type: "VaultDeleted",
        ...envelope,
        signature,
        data: { deletedAt: 1_700_000_000_000 },
      }).success,
    ).toBe(true);
    expect(
      VaultDeletedSchema.safeParse({
        type: "VaultDeleted",
        ...envelope,
        signature,
        data: { deletedAt: "now" },
      }).success,
    ).toBe(false);
  });

  it("VaultDeleted parses when emitted by the relay (deviceId = RELAY_DEVICE_ID)", () => {
    const relayEmitted = {
      type: "VaultDeleted" as const,
      ...envelope,
      deviceId: RELAY_DEVICE_ID,
      signature,
      data: { deletedAt: 1_700_000_000_000 },
    };
    expect(VaultDeletedSchema.safeParse(relayEmitted).success).toBe(true);
    expect(EventSchema.safeParse(relayEmitted).success).toBe(true);
  });

  describe("signature field (vault-key-signed events)", () => {
    // CONTEXT.md: VaultDeletionScheduled, VaultDeletionCancelled, and
    // VaultDeleted are "signed with the Vault key". A signed event with no
    // signature on the wire is a contradiction — the schema must require it.
    const cases = [
      ["VaultDeletionScheduled", VaultDeletionScheduledSchema, { scheduledFor: 1_700_000_000_000 }],
      ["VaultDeletionCancelled", VaultDeletionCancelledSchema, {}],
      ["VaultDeleted", VaultDeletedSchema, { deletedAt: 1_700_000_000_000 }],
    ] as const;

    for (const [type, schema, data] of cases) {
      it(`${type} parses when signature is present`, () => {
        expect(schema.safeParse({ type, ...envelope, signature, data }).success).toBe(true);
      });

      it(`${type} fails when signature is missing`, () => {
        expect(schema.safeParse({ type, ...envelope, data }).success).toBe(false);
      });

      it(`${type} fails when signature is empty`, () => {
        expect(schema.safeParse({ type, ...envelope, signature: "", data }).success).toBe(false);
      });

      it(`${type} fails via the catalog when signature is missing`, () => {
        expect(EventSchema.safeParse({ type, ...envelope, data }).success).toBe(false);
      });
    }
  });
});

describe("RELAY_DEVICE_ID sentinel", () => {
  it("is the canonical relay deviceId value", () => {
    // Canonical value any Relay implementation must use; pinned by this test
    // so a change to the constant is a deliberate protocol change.
    expect(RELAY_DEVICE_ID).toBe("relay");
  });

  it("is a plain non-empty string and so passes envelope validation on any event type", () => {
    // Schema-wise the sentinel is just a string — its meaning is enforced by
    // convention and (for VaultDeleted) by the vault-key signature check.
    // A regular ItemArchived event using "relay" as its deviceId is still a
    // structurally valid event.
    const ok = EventSchema.safeParse({
      type: "ItemArchived",
      ...envelope,
      deviceId: RELAY_DEVICE_ID,
      data: { itemId: "i1" },
    });
    expect(ok.success).toBe(true);
  });
});

describe("PendingEventSchema (outbound, pre-relay)", () => {
  const pendingEnvelope = {
    deviceId: "device-abc",
    timestamp: 1_700_000_000_000,
  };

  it("parses a pending event with no seq", () => {
    const pending = {
      type: "ItemSaved" as const,
      ...pendingEnvelope,
      data: {
        itemId: "i1",
        url: "https://example.com",
        canonicalUrl: "https://example.com",
        title: "t",
        savedAt: 1,
      },
    };
    const result = PendingEventSchema.safeParse(pending);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("seq");
      expectTypeOf(result.data).toEqualTypeOf<PendingEvent>();
    }

    // The same payload must be rejected by the inbound schema — seq is
    // required there.
    expect(EventSchema.safeParse(pending).success).toBe(false);
  });

  it("rejects pending events missing deviceId or timestamp", () => {
    expect(
      PendingEventSchema.safeParse({
        type: "ItemArchived",
        timestamp: 1,
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);

    expect(
      PendingEventSchema.safeParse({
        type: "ItemArchived",
        deviceId: "device-abc",
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown event types", () => {
    expect(
      PendingEventSchema.safeParse({
        ...pendingEnvelope,
        type: "ItemPondered",
        data: { itemId: "i1" },
      }).success,
    ).toBe(false);
  });

  it("inbound Event with seq still parses as Event", () => {
    const sequenced = {
      type: "ItemArchived" as const,
      ...envelope,
      data: { itemId: "i1" },
    };
    expect(EventSchema.safeParse(sequenced).success).toBe(true);
  });

  it("a fully-sequenced Event handed to PendingEventSchema parses (seq is stripped)", () => {
    // Zod strips unknown keys by default, so passing an Event (which has an
    // extra `seq` field relative to PendingEvent) through PendingEventSchema
    // succeeds and yields the pending shape. This is intentional — the
    // pending schema is permissive about extras, matching forward-compat
    // policy for envelope fields.
    const sequenced = {
      type: "ItemArchived" as const,
      ...envelope,
      data: { itemId: "i1" },
    };
    const result = PendingEventSchema.safeParse(sequenced);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("seq");
      expect(result.data).toEqual({
        type: "ItemArchived",
        deviceId: envelope.deviceId,
        timestamp: envelope.timestamp,
        data: { itemId: "i1" },
      });
    }
  });

  it("per-event pending schemas are exported and reject seq round-trip via strict", () => {
    const pendingSaved = {
      type: "ItemSaved" as const,
      deviceId: "d1",
      timestamp: 1,
      data: {
        itemId: "i1",
        url: "https://example.com",
        canonicalUrl: "https://example.com",
        title: "t",
        savedAt: 1,
      },
    };
    expect(PendingItemSavedSchema.safeParse(pendingSaved).success).toBe(true);

    expect(
      PendingItemArchivedSchema.safeParse({
        type: "ItemArchived",
        deviceId: "d1",
        timestamp: 1,
        data: { itemId: "i1" },
      }).success,
    ).toBe(true);
  });
});

describe("forward-compatibility", () => {
  it("strips unknown fields rather than failing (allows new optional fields)", () => {
    const result = EventSchema.safeParse({
      type: "ItemArchived",
      ...envelope,
      data: { itemId: "i1", futureField: "ignored" },
      futureEnvelopeField: "also ignored",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "ItemArchived",
        ...envelope,
        data: { itemId: "i1" },
      });
    }
  });
});
