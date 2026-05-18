import { describe, expect, it } from "vitest";

import { isBip39Word, suggestBip39Words, BIP39_WORDLIST } from "./bip39-wordlist.js";

describe("BIP39 wordlist", () => {
  it("contains exactly 2048 words", () => {
    expect(BIP39_WORDLIST.length).toBe(2048);
  });

  it("isBip39Word folds case and trims whitespace", () => {
    expect(isBip39Word("abandon")).toBe(true);
    expect(isBip39Word("  ABANDON  ")).toBe(true);
    expect(isBip39Word("notaword")).toBe(false);
  });

  it("suggestBip39Words returns words matching the prefix, capped at limit", () => {
    const hits = suggestBip39Words("aba", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    for (const word of hits) {
      expect(word.startsWith("aba")).toBe(true);
    }
  });

  it("returns empty list on empty / whitespace prefix", () => {
    expect(suggestBip39Words("")).toEqual([]);
    expect(suggestBip39Words("   ")).toEqual([]);
  });

  it("returns empty list when nothing matches", () => {
    expect(suggestBip39Words("zzz")).toEqual([]);
  });
});
