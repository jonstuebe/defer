import { describe, expect, it } from "vitest";

import { makeMnemonicChallenge, verifyMnemonicAnswers } from "./verify-mnemonic.js";

describe("makeMnemonicChallenge", () => {
  it("returns four distinct 1-indexed positions in ascending order", () => {
    const challenge = makeMnemonicChallenge(24, 4, mulberry32(42));
    expect(challenge.positions).toHaveLength(4);
    expect(new Set(challenge.positions).size).toBe(4);
    for (const position of challenge.positions) {
      expect(position).toBeGreaterThanOrEqual(1);
      expect(position).toBeLessThanOrEqual(24);
    }
    const sorted = [...challenge.positions].sort((a, b) => a - b);
    expect(challenge.positions).toEqual(sorted);
  });

  it("rejects challengeSize > wordCount", () => {
    expect(() => makeMnemonicChallenge(3, 4)).toThrow(/wordCount.*challengeSize/);
  });
});

describe("verifyMnemonicAnswers", () => {
  const words = [
    "abandon",
    "ability",
    "able",
    "about",
    "above",
    "absent",
    "absorb",
    "abstract",
    "absurd",
    "abuse",
    "access",
    "accident",
  ];

  it("accepts correct answers at every position", () => {
    const challenge = { positions: [1, 3, 5, 7] as const };
    const answers = new Map([
      [1, "abandon"],
      [3, "able"],
      [5, "above"],
      [7, "absorb"],
    ]);
    expect(verifyMnemonicAnswers(words, challenge, answers)).toEqual({ ok: true });
  });

  it("flags the wrong positions and is case-insensitive plus whitespace-tolerant", () => {
    const challenge = { positions: [2, 4, 6, 8] as const };
    const answers = new Map([
      [2, "ABILITY"],
      [4, "  about  "],
      [6, "wrong"],
      [8, "abstract"],
    ]);
    expect(verifyMnemonicAnswers(words, challenge, answers)).toEqual({
      ok: false,
      wrongPositions: [6],
    });
  });

  it("flags blank answers as wrong", () => {
    const challenge = { positions: [1, 2] as const };
    const answers = new Map([[1, "abandon"]]);
    expect(verifyMnemonicAnswers(words, challenge, answers)).toEqual({
      ok: false,
      wrongPositions: [2],
    });
  });
});

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
