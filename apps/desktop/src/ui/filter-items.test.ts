import { describe, expect, it } from "vitest";
import type { Item } from "@defer/core";

import { filterItems } from "./filter-items.js";

function makeItem(overrides: Partial<Item>): Item {
  return {
    id: "item-" + Math.random().toString(36).slice(2, 10),
    url: "https://example.com",
    canonicalUrl: "https://example.com",
    title: "Example",
    state: "inbox",
    liked: false,
    tags: [],
    savedAt: 1,
    createdAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe("filterItems", () => {
  const items: Item[] = [
    makeItem({ id: "1", state: "inbox", liked: false }),
    makeItem({ id: "2", state: "inbox", liked: true }),
    makeItem({ id: "3", state: "archive", liked: false }),
    makeItem({ id: "4", state: "archive", liked: true }),
    makeItem({ id: "5", state: "inbox", liked: false, deletedAt: 100 }),
  ];

  it("inbox filter returns only inbox items (excludes deleted)", () => {
    expect(filterItems(items, "inbox").map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("archive filter returns only archive items", () => {
    expect(filterItems(items, "archive").map((i) => i.id)).toEqual(["3", "4"]);
  });

  it("liked filter spans both states (PRD US #53)", () => {
    expect(filterItems(items, "liked").map((i) => i.id)).toEqual(["2", "4"]);
  });

  it("excludes soft-deleted items from every filter", () => {
    expect(filterItems(items, "inbox").every((i) => i.deletedAt === null)).toBe(true);
    expect(filterItems(items, "archive").every((i) => i.deletedAt === null)).toBe(true);
    expect(filterItems(items, "liked").every((i) => i.deletedAt === null)).toBe(true);
  });
});
