import { describe, expect, it } from "vitest";

import { apply, initialVaultState, type VaultState } from "../index.js";
import type { Event } from "../../events/index.js";

const SIG = "c2lnbmF0dXJlLWJ5dGVz";

const env = (
  seq: number,
  overrides: Partial<{ deviceId: string; timestamp: number }> = {},
): { seq: number; deviceId: string; timestamp: number } => ({
  seq,
  deviceId: "device-abc",
  timestamp: 1_700_000_000_000,
  ...overrides,
});

const itemSaved = (
  seq: number,
  data: {
    itemId: string;
    url?: string;
    canonicalUrl?: string;
    title?: string;
    savedAt?: number;
  },
  envOverrides: Partial<{ deviceId: string; timestamp: number }> = {},
): Event => ({
  type: "ItemSaved",
  ...env(seq, envOverrides),
  data: {
    itemId: data.itemId,
    url: data.url ?? `https://example.com/${data.itemId}`,
    canonicalUrl: data.canonicalUrl ?? `https://example.com/${data.itemId}`,
    title: data.title ?? `Title ${data.itemId}`,
    savedAt: data.savedAt ?? 1_700_000_000_000,
  },
});

// Seed helper: creates an item and returns the resulting state.
function seedItem(
  state: VaultState,
  itemId: string,
  options: { canonicalUrl?: string; url?: string; title?: string; savedAt?: number } = {},
  seq = 1,
): VaultState {
  return apply(state, itemSaved(seq, { itemId, ...options }));
}

describe("apply — purity & guarantees", () => {
  it("does not mutate the input state (deep freeze the input)", () => {
    const state = initialVaultState();
    Object.freeze(state);
    Object.freeze(state.items);
    Object.freeze(state.itemsByCanonicalUrl);
    Object.freeze(state.tags);
    Object.freeze(state.devices);

    expect(() => apply(state, itemSaved(1, { itemId: "i1" }))).not.toThrow();
  });

  it("returns a new state object reference when state actually changes", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, itemSaved(1, { itemId: "i1" }));
    expect(s1).not.toBe(s0);
  });

  it("unknown event type returns the input state identity-equal", () => {
    const s0 = initialVaultState();
    // Cast through unknown to bypass the discriminated-union narrowing.
    const forwardEvent = {
      type: "UnknownInTheFuture",
      ...env(1),
      data: { itemId: "i1" },
    } as unknown as Event;
    const s1 = apply(s0, forwardEvent);
    expect(s1).toBe(s0);
  });
});

describe("ItemSaved (create)", () => {
  it("creates a new item with default fields and indexes canonicalUrl", () => {
    const s0 = initialVaultState();
    const s1 = apply(
      s0,
      itemSaved(
        1,
        {
          itemId: "i1",
          url: "https://example.com/a",
          canonicalUrl: "https://example.com/a",
          title: "Hello",
          savedAt: 1_700_000_000_500,
        },
        { timestamp: 1_700_000_000_900 },
      ),
    );

    const item = s1.items.get("i1");
    expect(item).toBeDefined();
    expect(item).toEqual({
      id: "i1",
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "Hello",
      state: "inbox",
      liked: false,
      tags: [],
      savedAt: 1_700_000_000_500,
      createdAt: 1_700_000_000_900,
      deletedAt: null,
    });
    expect(s1.itemsByCanonicalUrl.get("https://example.com/a")).toBe("i1");
  });

  it("idempotent re-apply with the same itemId is a no-op", () => {
    const s0 = initialVaultState();
    const e = itemSaved(1, { itemId: "i1" });
    const s1 = apply(s0, e);
    const s2 = apply(s1, e);
    expect(s2).toBe(s1);
  });
});

describe("ItemSaved (touch existing canonicalUrl)", () => {
  it("touch from inbox bumps savedAt and stays inbox; no new item", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1", { canonicalUrl: "https://example.com/a", savedAt: 100 }, 1);
    expect(s1.items.size).toBe(1);

    const s2 = apply(
      s1,
      itemSaved(2, {
        itemId: "i2", // different itemId; touch should NOT create
        url: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        title: "ignored-new-title",
        savedAt: 999,
      }),
    );

    expect(s2.items.size).toBe(1);
    expect(s2.items.has("i2")).toBe(false);
    const item = s2.items.get("i1");
    expect(item).toBeDefined();
    expect(item?.savedAt).toBe(999);
    expect(item?.state).toBe("inbox");
    // unchanged fields
    expect(item?.id).toBe("i1");
    expect(item?.title).toBe("Title i1");
    expect(item?.liked).toBe(false);
    expect(item?.tags).toEqual([]);
    expect(item?.deletedAt).toBeNull();
  });

  it("touch from archive returns the item to inbox and bumps savedAt", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1", { canonicalUrl: "https://example.com/a", savedAt: 100 });
    const archived = apply(s1, {
      type: "ItemArchived",
      ...env(2),
      data: { itemId: "i1" },
    });
    expect(archived.items.get("i1")?.state).toBe("archive");

    const touched = apply(
      archived,
      itemSaved(3, {
        itemId: "i9",
        url: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        savedAt: 500,
      }),
    );
    expect(touched.items.size).toBe(1);
    expect(touched.items.get("i1")?.state).toBe("inbox");
    expect(touched.items.get("i1")?.savedAt).toBe(500);
  });
});

describe("ItemSaved on a soft-deleted item with same canonicalUrl", () => {
  it("creates a NEW item; the tombstone remains untouched", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1", { canonicalUrl: "https://example.com/a" });
    const deleted = apply(s1, {
      type: "ItemDeleted",
      ...env(2, { timestamp: 1_700_000_001_000 }),
      data: { itemId: "i1" },
    });

    expect(deleted.items.get("i1")?.deletedAt).toBe(1_700_000_001_000);
    expect(deleted.itemsByCanonicalUrl.has("https://example.com/a")).toBe(false);

    const created = apply(
      deleted,
      itemSaved(3, {
        itemId: "i2",
        url: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
      }),
    );

    expect(created.items.size).toBe(2);
    expect(created.items.get("i1")?.deletedAt).toBe(1_700_000_001_000);
    expect(created.items.get("i2")).toBeDefined();
    expect(created.items.get("i2")?.deletedAt).toBeNull();
    expect(created.itemsByCanonicalUrl.get("https://example.com/a")).toBe("i2");
  });
});

describe("ItemArchived / ItemUnarchived / ItemLiked / ItemUnliked / ItemTitleEdited", () => {
  type SimpleType =
    | "ItemArchived"
    | "ItemUnarchived"
    | "ItemLiked"
    | "ItemUnliked"
    | "ItemTitleEdited";

  const makeEvent = (type: SimpleType, seq: number, itemId: string): Event => {
    if (type === "ItemTitleEdited") {
      return {
        type,
        ...env(seq),
        data: { itemId, title: "Edited Title" },
      };
    }
    return {
      type,
      ...env(seq),
      data: { itemId },
    };
  };

  const cases: SimpleType[] = [
    "ItemArchived",
    "ItemUnarchived",
    "ItemLiked",
    "ItemUnliked",
    "ItemTitleEdited",
  ];

  for (const type of cases) {
    it(`${type}: unknown itemId is a no-op (identity-equal)`, () => {
      const s0 = initialVaultState();
      const s1 = seedItem(s0, "i1");
      const s2 = apply(s1, makeEvent(type, 2, "missing"));
      expect(s2).toBe(s1);
    });

    it(`${type}: soft-deleted item is a no-op`, () => {
      const s0 = initialVaultState();
      const s1 = seedItem(s0, "i1");
      const deleted = apply(s1, {
        type: "ItemDeleted",
        ...env(2),
        data: { itemId: "i1" },
      });
      const s3 = apply(deleted, makeEvent(type, 3, "i1"));
      expect(s3).toBe(deleted);
    });

    it(`${type}: re-applying twice yields the same state as applying once`, () => {
      const s0 = initialVaultState();
      const s1 = seedItem(s0, "i1");
      const e1 = makeEvent(type, 2, "i1");
      const e2 = makeEvent(type, 3, "i1");
      const after1 = apply(s1, e1);
      const after2 = apply(after1, e2);
      // Idempotent: second apply changes nothing observable about the item.
      expect(after2.items.get("i1")).toEqual(after1.items.get("i1"));
    });
  }

  it("ItemArchived sets state to archive; ItemUnarchived sets it back to inbox", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const arch = apply(s1, { type: "ItemArchived", ...env(2), data: { itemId: "i1" } });
    expect(arch.items.get("i1")?.state).toBe("archive");

    const unarch = apply(arch, { type: "ItemUnarchived", ...env(3), data: { itemId: "i1" } });
    expect(unarch.items.get("i1")?.state).toBe("inbox");
  });

  it("ItemLiked sets liked to true; ItemUnliked sets it back to false", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const liked = apply(s1, { type: "ItemLiked", ...env(2), data: { itemId: "i1" } });
    expect(liked.items.get("i1")?.liked).toBe(true);

    const unliked = apply(liked, { type: "ItemUnliked", ...env(3), data: { itemId: "i1" } });
    expect(unliked.items.get("i1")?.liked).toBe(false);
  });

  it("ItemTitleEdited updates the title (including empty string)", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1", { title: "Original" });
    const edited = apply(s1, {
      type: "ItemTitleEdited",
      ...env(2),
      data: { itemId: "i1", title: "New Title" },
    });
    expect(edited.items.get("i1")?.title).toBe("New Title");

    const cleared = apply(edited, {
      type: "ItemTitleEdited",
      ...env(3),
      data: { itemId: "i1", title: "" },
    });
    expect(cleared.items.get("i1")?.title).toBe("");
  });
});

describe("ItemTagged", () => {
  it("unknown item is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "ItemTagged",
      ...env(1),
      data: { itemId: "missing", tag: "rust" },
    });
    expect(s1).toBe(s0);
  });

  it("soft-deleted item is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const deleted = apply(s1, { type: "ItemDeleted", ...env(2), data: { itemId: "i1" } });
    const tagged = apply(deleted, {
      type: "ItemTagged",
      ...env(3),
      data: { itemId: "i1", tag: "rust" },
    });
    expect(tagged).toBe(deleted);
  });

  it("adding an existing tag is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const tagged = apply(s1, {
      type: "ItemTagged",
      ...env(2),
      data: { itemId: "i1", tag: "rust" },
    });
    const reTagged = apply(tagged, {
      type: "ItemTagged",
      ...env(3),
      data: { itemId: "i1", tag: "rust" },
    });
    expect(reTagged).toBe(tagged);
    expect(tagged.items.get("i1")?.tags).toEqual(["rust"]);
  });

  it("keeps the per-item tags array sorted ascending", () => {
    const s0 = initialVaultState();
    let s = seedItem(s0, "i1");
    for (const tag of ["zebra", "apple", "mango", "banana"]) {
      s = apply(s, { type: "ItemTagged", ...env(2), data: { itemId: "i1", tag } });
    }
    expect(s.items.get("i1")?.tags).toEqual(["apple", "banana", "mango", "zebra"]);
  });

  it("adds the tag to the global state.tags set", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const tagged = apply(s1, {
      type: "ItemTagged",
      ...env(2),
      data: { itemId: "i1", tag: "rust" },
    });
    expect(tagged.tags.has("rust")).toBe(true);
  });
});

describe("ItemUntagged", () => {
  it("unknown item is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "ItemUntagged",
      ...env(1),
      data: { itemId: "missing", tag: "rust" },
    });
    expect(s1).toBe(s0);
  });

  it("soft-deleted item is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const tagged = apply(s1, {
      type: "ItemTagged",
      ...env(2),
      data: { itemId: "i1", tag: "rust" },
    });
    const deleted = apply(tagged, { type: "ItemDeleted", ...env(3), data: { itemId: "i1" } });
    const untagged = apply(deleted, {
      type: "ItemUntagged",
      ...env(4),
      data: { itemId: "i1", tag: "rust" },
    });
    expect(untagged).toBe(deleted);
  });

  it("removing a non-present tag is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const untagged = apply(s1, {
      type: "ItemUntagged",
      ...env(2),
      data: { itemId: "i1", tag: "nope" },
    });
    expect(untagged).toBe(s1);
  });

  it("drops the global tag when its last carrier removes it", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const tagged = apply(s1, {
      type: "ItemTagged",
      ...env(2),
      data: { itemId: "i1", tag: "rust" },
    });
    const untagged = apply(tagged, {
      type: "ItemUntagged",
      ...env(3),
      data: { itemId: "i1", tag: "rust" },
    });
    expect(untagged.tags.has("rust")).toBe(false);
  });

  it("keeps the global tag if another item still carries it", () => {
    const s0 = initialVaultState();
    let s = seedItem(s0, "i1", { canonicalUrl: "https://example.com/1" }, 1);
    s = seedItem(s, "i2", { canonicalUrl: "https://example.com/2" }, 2);
    s = apply(s, {
      type: "ItemTagged",
      ...env(3),
      data: { itemId: "i1", tag: "rust" },
    });
    s = apply(s, {
      type: "ItemTagged",
      ...env(4),
      data: { itemId: "i2", tag: "rust" },
    });
    s = apply(s, {
      type: "ItemUntagged",
      ...env(5),
      data: { itemId: "i1", tag: "rust" },
    });
    expect(s.tags.has("rust")).toBe(true);
    expect(s.items.get("i2")?.tags).toEqual(["rust"]);
  });
});

describe("ItemDeleted", () => {
  it("unknown item is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, { type: "ItemDeleted", ...env(1), data: { itemId: "missing" } });
    expect(s1).toBe(s0);
  });

  it("already-deleted item is a no-op (idempotent)", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1");
    const deleted = apply(s1, { type: "ItemDeleted", ...env(2), data: { itemId: "i1" } });
    const again = apply(deleted, { type: "ItemDeleted", ...env(3), data: { itemId: "i1" } });
    expect(again).toBe(deleted);
  });

  it("sets deletedAt to event.timestamp and removes the canonicalUrl mapping", () => {
    const s0 = initialVaultState();
    const s1 = seedItem(s0, "i1", { canonicalUrl: "https://example.com/a" });
    const deleted = apply(s1, {
      type: "ItemDeleted",
      ...env(2, { timestamp: 1_700_000_002_000 }),
      data: { itemId: "i1" },
    });
    expect(deleted.items.get("i1")?.deletedAt).toBe(1_700_000_002_000);
    expect(deleted.itemsByCanonicalUrl.has("https://example.com/a")).toBe(false);
  });

  it("recomputes global tags so the deleted item's exclusive tag disappears", () => {
    const s0 = initialVaultState();
    let s = seedItem(s0, "i1");
    s = apply(s, { type: "ItemTagged", ...env(2), data: { itemId: "i1", tag: "rust" } });
    expect(s.tags.has("rust")).toBe(true);

    s = apply(s, { type: "ItemDeleted", ...env(3), data: { itemId: "i1" } });
    expect(s.tags.has("rust")).toBe(false);
  });
});

describe("DeviceRegistered / DeviceRevoked", () => {
  it("DeviceRegistered adds a record keyed by deviceId", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "DeviceRegistered",
      ...env(1),
      data: {
        deviceId: "d1",
        deviceName: "Jon's iPhone",
        deviceType: "mobile",
        registeredAt: 1_700_000_000_000,
      },
    });
    expect(s1.devices.get("d1")).toEqual({
      name: "Jon's iPhone",
      type: "mobile",
      registeredAt: 1_700_000_000_000,
    });
  });

  it("re-registering the same deviceId is a no-op (first registration wins)", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "DeviceRegistered",
      ...env(1),
      data: {
        deviceId: "d1",
        deviceName: "First",
        deviceType: "mobile",
        registeredAt: 100,
      },
    });
    const s2 = apply(s1, {
      type: "DeviceRegistered",
      ...env(2),
      data: {
        deviceId: "d1",
        deviceName: "Second",
        deviceType: "desktop",
        registeredAt: 200,
      },
    });
    expect(s2).toBe(s1);
    expect(s2.devices.get("d1")?.name).toBe("First");
  });

  it("DeviceRevoked removes the device", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "DeviceRegistered",
      ...env(1),
      data: { deviceId: "d1", deviceName: "p", deviceType: "mobile", registeredAt: 1 },
    });
    const s2 = apply(s1, { type: "DeviceRevoked", ...env(2), data: { deviceId: "d1" } });
    expect(s2.devices.has("d1")).toBe(false);
  });

  it("DeviceRevoked for an unknown deviceId is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, { type: "DeviceRevoked", ...env(1), data: { deviceId: "d1" } });
    expect(s1).toBe(s0);
  });
});

describe("VaultDeletionScheduled / Cancelled", () => {
  it("schedules using envelope.deviceId as scheduledBy and data.scheduledFor", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "VaultDeletionScheduled",
      ...env(1, { deviceId: "device-X" }),
      signature: SIG,
      data: { scheduledFor: 1_700_999_999_000 },
    });
    expect(s1.scheduledDeletion).toEqual({
      scheduledFor: 1_700_999_999_000,
      scheduledBy: "device-X",
    });
  });

  it("VaultDeletionScheduled re-apply yields a deep-equal state", () => {
    const s0 = initialVaultState();
    const e: Event = {
      type: "VaultDeletionScheduled",
      ...env(1),
      signature: SIG,
      data: { scheduledFor: 1_700_999_999_000 },
    };
    const s1 = apply(s0, e);
    const s2 = apply(s1, e);
    expect(s2.scheduledDeletion).toEqual(s1.scheduledDeletion);
  });

  it("VaultDeletionCancelled nulls out scheduledDeletion", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "VaultDeletionScheduled",
      ...env(1),
      signature: SIG,
      data: { scheduledFor: 1_700_999_999_000 },
    });
    const s2 = apply(s1, {
      type: "VaultDeletionCancelled",
      ...env(2),
      signature: SIG,
      data: {},
    });
    expect(s2.scheduledDeletion).toBeNull();

    const s3 = apply(s2, {
      type: "VaultDeletionCancelled",
      ...env(3),
      signature: SIG,
      data: {},
    });
    expect(s3.scheduledDeletion).toBeNull();
  });
});

describe("VaultDeleted kill switch", () => {
  it("sets isDeleted to true", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "VaultDeleted",
      ...env(1),
      signature: SIG,
      data: { deletedAt: 1_700_000_002_000 },
    });
    expect(s1.isDeleted).toBe(true);
  });

  it("once isDeleted, an item-family event is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "VaultDeleted",
      ...env(1),
      signature: SIG,
      data: { deletedAt: 1_700_000_002_000 },
    });
    const s2 = apply(s1, itemSaved(2, { itemId: "i1" }));
    expect(s2).toBe(s1);
  });

  it("once isDeleted, a device-family event is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "VaultDeleted",
      ...env(1),
      signature: SIG,
      data: { deletedAt: 1_700_000_002_000 },
    });
    const s2 = apply(s1, {
      type: "DeviceRegistered",
      ...env(2),
      data: {
        deviceId: "d1",
        deviceName: "p",
        deviceType: "mobile",
        registeredAt: 100,
      },
    });
    expect(s2).toBe(s1);
  });

  it("once isDeleted, a vault-family event is a no-op", () => {
    const s0 = initialVaultState();
    const s1 = apply(s0, {
      type: "VaultDeleted",
      ...env(1),
      signature: SIG,
      data: { deletedAt: 1_700_000_002_000 },
    });
    const s2 = apply(s1, {
      type: "VaultDeletionScheduled",
      ...env(2),
      signature: SIG,
      data: { scheduledFor: 1_700_000_009_000 },
    });
    expect(s2).toBe(s1);
  });
});
