import { describe, expect, it } from "vitest";

import { apply, initialVaultState } from "../index.js";
import type { Event } from "../../events/index.js";

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

describe("ItemSaved touch semantics", () => {
  it("touching an inbox item bumps savedAt and leaves it in inbox", () => {
    const s0 = initialVaultState();
    const created = apply(
      s0,
      itemSaved(1, {
        itemId: "i1",
        canonicalUrl: "https://example.com/page",
        savedAt: 100,
        title: "Original",
      }),
    );
    expect(created.items.get("i1")?.state).toBe("inbox");
    expect(created.items.get("i1")?.savedAt).toBe(100);

    const touched = apply(
      created,
      itemSaved(2, {
        itemId: "i-DIFFERENT",
        canonicalUrl: "https://example.com/page",
        savedAt: 500,
        title: "Touch payload title — should NOT overwrite",
      }),
    );

    expect(touched.items.size).toBe(1);
    const item = touched.items.get("i1");
    expect(item).toBeDefined();
    expect(item?.state).toBe("inbox");
    expect(item?.savedAt).toBe(500);
    // unchanged identity fields
    expect(item?.id).toBe("i1");
    expect(item?.title).toBe("Original");
    expect(item?.liked).toBe(false);
    expect(item?.tags).toEqual([]);
    expect(item?.deletedAt).toBeNull();
  });

  it("touching an archived item bumps savedAt AND returns it to inbox", () => {
    const s0 = initialVaultState();
    const created = apply(
      s0,
      itemSaved(1, {
        itemId: "i1",
        canonicalUrl: "https://example.com/page",
        savedAt: 100,
      }),
    );
    const archived = apply(created, {
      type: "ItemArchived",
      ...env(2),
      data: { itemId: "i1" },
    });
    expect(archived.items.get("i1")?.state).toBe("archive");

    const touched = apply(
      archived,
      itemSaved(3, {
        itemId: "i-DIFFERENT",
        canonicalUrl: "https://example.com/page",
        savedAt: 700,
      }),
    );

    expect(touched.items.size).toBe(1);
    expect(touched.items.get("i1")?.state).toBe("inbox");
    expect(touched.items.get("i1")?.savedAt).toBe(700);
  });

  it("touch does NOT modify createdAt, url, liked, tags, or deletedAt", () => {
    const s0 = initialVaultState();
    const created = apply(
      s0,
      itemSaved(
        1,
        {
          itemId: "i1",
          url: "https://example.com/page?utm=foo",
          canonicalUrl: "https://example.com/page",
          savedAt: 100,
          title: "Hello",
        },
        { timestamp: 1_700_000_000_111 },
      ),
    );
    const liked = apply(created, { type: "ItemLiked", ...env(2), data: { itemId: "i1" } });
    const tagged = apply(liked, {
      type: "ItemTagged",
      ...env(3),
      data: { itemId: "i1", tag: "alpha" },
    });

    const touched = apply(
      tagged,
      itemSaved(
        4,
        {
          itemId: "i-DIFFERENT",
          url: "https://example.com/page?utm=bar",
          canonicalUrl: "https://example.com/page",
          savedAt: 900,
          title: "New",
        },
        { timestamp: 1_700_000_000_999 },
      ),
    );

    const item = touched.items.get("i1");
    expect(item).toBeDefined();
    expect(item?.url).toBe("https://example.com/page?utm=foo");
    expect(item?.title).toBe("Hello");
    expect(item?.liked).toBe(true);
    expect(item?.tags).toEqual(["alpha"]);
    expect(item?.createdAt).toBe(1_700_000_000_111);
    expect(item?.deletedAt).toBeNull();
    expect(item?.savedAt).toBe(900);
    expect(item?.state).toBe("inbox");
  });

  it("touch does NOT create a second item under the new itemId", () => {
    const s0 = initialVaultState();
    const created = apply(
      s0,
      itemSaved(1, { itemId: "i1", canonicalUrl: "https://example.com/page" }),
    );
    const touched = apply(
      created,
      itemSaved(2, { itemId: "i2", canonicalUrl: "https://example.com/page" }),
    );
    expect(touched.items.size).toBe(1);
    expect(touched.items.has("i1")).toBe(true);
    expect(touched.items.has("i2")).toBe(false);
    expect(touched.itemsByCanonicalUrl.get("https://example.com/page")).toBe("i1");
  });
});
