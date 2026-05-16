import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EventSchema,
  type Event,
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
  it("VaultDeletionScheduled requires scheduledFor (emitter is the envelope's deviceId)", () => {
    const valid = {
      type: "VaultDeletionScheduled" as const,
      ...envelope,
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
        data: {},
      }).success,
    ).toBe(true);
  });

  it("VaultDeletionCancelled strips legacy/unknown fields like `cancelledBy`", () => {
    const result = VaultDeletionCancelledSchema.safeParse({
      type: "VaultDeletionCancelled",
      ...envelope,
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
        data: { deletedAt: 1_700_000_000_000 },
      }).success,
    ).toBe(true);
    expect(
      VaultDeletedSchema.safeParse({
        type: "VaultDeleted",
        ...envelope,
        data: { deletedAt: "now" },
      }).success,
    ).toBe(false);
  });

  it("VaultDeleted parses when emitted by the relay (deviceId = RELAY_DEVICE_ID)", () => {
    const relayEmitted = {
      type: "VaultDeleted" as const,
      ...envelope,
      deviceId: RELAY_DEVICE_ID,
      data: { deletedAt: 1_700_000_000_000 },
    };
    expect(VaultDeletedSchema.safeParse(relayEmitted).success).toBe(true);
    expect(EventSchema.safeParse(relayEmitted).success).toBe(true);
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
