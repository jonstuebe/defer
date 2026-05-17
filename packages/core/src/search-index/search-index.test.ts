import { describe, expect, it } from "vitest";
import type { Event } from "../events/index.js";

import { SearchIndex } from "./search-index.js";

function makeSaved(itemId: string, title: string, url: string, seq = 1): Event {
  return {
    type: "ItemSaved",
    seq,
    deviceId: "deviceAAAAAAAAAAAAAAA",
    timestamp: 1_700_000_000_000,
    clientNonce: ("nonce" + itemId.padEnd(17, "X")).slice(0, 22),
    data: {
      itemId,
      url,
      canonicalUrl: url,
      title,
      savedAt: 1_700_000_000_000,
    },
  };
}

function makeTitleEdited(itemId: string, title: string, seq = 1): Event {
  return {
    type: "ItemTitleEdited",
    seq,
    deviceId: "deviceAAAAAAAAAAAAAAA",
    timestamp: 1_700_000_000_000,
    clientNonce: ("editt" + itemId.padEnd(17, "X")).slice(0, 22),
    data: { itemId, title },
  };
}

function makeDeleted(itemId: string, seq = 1): Event {
  return {
    type: "ItemDeleted",
    seq,
    deviceId: "deviceAAAAAAAAAAAAAAA",
    timestamp: 1_700_000_000_000,
    clientNonce: ("dellt" + itemId.padEnd(17, "X")).slice(0, 22),
    data: { itemId },
  };
}

describe("SearchIndex", () => {
  it("returns no hits for an empty query", () => {
    const index = new SearchIndex();
    index.apply(makeSaved("a", "Rust ownership", "https://blog.example/rust"));
    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
  });

  it("matches a single token against title", () => {
    const index = new SearchIndex();
    index.apply(makeSaved("a", "Rust ownership", "https://blog.example/rust"));
    index.apply(makeSaved("b", "Python typing", "https://blog.example/python"));
    const hits = index.search("ownership");
    expect(hits.map((h) => h.itemId)).toEqual(["a"]);
  });

  it("matches against URL hostname + path", () => {
    const index = new SearchIndex();
    index.apply(makeSaved("a", "", "https://news.ycombinator.com/item?id=12345"));
    const byHost = index.search("ycombinator");
    expect(byHost.map((h) => h.itemId)).toEqual(["a"]);
    const byPath = index.search("12345");
    expect(byPath.map((h) => h.itemId)).toEqual(["a"]);
  });

  it("ranks items matching more query tokens higher", () => {
    const index = new SearchIndex();
    index.apply(makeSaved("a", "Rust ownership patterns", ""));
    index.apply(makeSaved("b", "Rust ownership", ""));
    index.apply(makeSaved("c", "Patterns of usage", ""));
    const hits = index.search("rust ownership patterns");
    expect(hits[0]?.itemId).toBe("a");
    expect(hits[0]?.score).toBe(3);
  });

  it("updates the index on ItemTitleEdited", () => {
    const index = new SearchIndex();
    index.apply(makeSaved("a", "First name", "https://example.com/a"));
    expect(index.search("first").map((h) => h.itemId)).toEqual(["a"]);
    index.apply(makeTitleEdited("a", "Second name"));
    expect(index.search("first")).toEqual([]);
    expect(index.search("second").map((h) => h.itemId)).toEqual(["a"]);
  });

  it("removes the item on ItemDeleted", () => {
    const index = new SearchIndex();
    index.apply(makeSaved("a", "Rust", "https://example.com/a"));
    index.apply(makeDeleted("a"));
    expect(index.search("rust")).toEqual([]);
    expect(index.size()).toBe(0);
  });

  it("is case-insensitive on the query but case-folding on the index", () => {
    const index = new SearchIndex();
    index.apply(makeSaved("a", "Rust", ""));
    expect(index.search("RUST").map((h) => h.itemId)).toEqual(["a"]);
    expect(index.search("rust").map((h) => h.itemId)).toEqual(["a"]);
  });

  it("respects the limit parameter", () => {
    const index = new SearchIndex();
    for (let i = 0; i < 10; i += 1) {
      index.apply(makeSaved(`item-${i}`, "shared keyword", ""));
    }
    expect(index.search("shared", 3).length).toBe(3);
  });
});
