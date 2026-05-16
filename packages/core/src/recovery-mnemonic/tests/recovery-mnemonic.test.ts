import { describe, expect, it } from "vitest";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { decodeMnemonic, deriveVaultIdFromKey, encodeVaultKey } from "../index.js";

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVaultKey(rng: () => number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(rng() * 256);
  }
  return bytes;
}

describe("encodeVaultKey", () => {
  it("encodes a 32-byte vault key as 24 space-separated BIP-39 words", () => {
    const key = new Uint8Array(32);
    const mnemonic = encodeVaultKey(key);
    const words = mnemonic.split(" ");
    expect(words).toHaveLength(24);
    for (const word of words) {
      expect(wordlist).toContain(word);
    }
  });

  it("rejects vault keys that are not 32 bytes", () => {
    expect(() => encodeVaultKey(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(() => encodeVaultKey(new Uint8Array(48))).toThrow(/32 bytes/);
  });
});

describe("decodeMnemonic", () => {
  it("round-trips random vault keys (10 iterations with seeded RNG)", () => {
    const rng = seededRng(0xc0ffee);
    for (let i = 0; i < 10; i++) {
      const key = randomVaultKey(rng);
      const mnemonic = encodeVaultKey(key);
      const decoded = decodeMnemonic(mnemonic);
      expect(decoded).toEqual(key);
    }
  });

  it("rejects checksum-corrupted mnemonics", () => {
    const key = randomVaultKey(seededRng(1));
    const mnemonic = encodeVaultKey(key);
    const words = mnemonic.split(" ");
    const lastIdx = wordlist.indexOf(words[words.length - 1]!);
    // Flipping the lowest bit of the final 11-bit chunk perturbs only the
    // checksum portion (entropy stays identical), so the recomputed checksum
    // must mismatch — a deterministic invalid mnemonic.
    words[words.length - 1] = wordlist[lastIdx ^ 1]!;
    const corrupted = words.join(" ");

    expect(() => decodeMnemonic(corrupted)).toThrow(/checksum/);
  });

  it("rejects mnemonics containing non-wordlist words", () => {
    const key = randomVaultKey(seededRng(2));
    const words = encodeVaultKey(key).split(" ");
    words[5] = "notaword";
    expect(() => decodeMnemonic(words.join(" "))).toThrow(/notaword/);
  });

  it("tolerates leading, trailing, and multiple internal spaces", () => {
    const key = randomVaultKey(seededRng(3));
    const mnemonic = encodeVaultKey(key);
    const messy = `   ${mnemonic.replace(/ /g, "   ")}   \n  `;
    expect(decodeMnemonic(messy)).toEqual(key);
  });

  it("rejects mnemonics with the wrong word count", () => {
    const key = randomVaultKey(seededRng(4));
    const words = encodeVaultKey(key).split(" ");
    expect(() => decodeMnemonic(words.slice(0, 23).join(" "))).toThrow(/24 words/);
  });
});

describe("deriveVaultIdFromKey", () => {
  it("returns a 16-byte vault ID", () => {
    const key = randomVaultKey(seededRng(5));
    const id = deriveVaultIdFromKey(key);
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id).toHaveLength(16);
  });

  it("is deterministic for a given vault key", () => {
    const key = randomVaultKey(seededRng(6));
    expect(deriveVaultIdFromKey(key)).toEqual(deriveVaultIdFromKey(key));
  });

  it("produces distinct IDs for distinct vault keys", () => {
    const rng = seededRng(7);
    const a = deriveVaultIdFromKey(randomVaultKey(rng));
    const b = deriveVaultIdFromKey(randomVaultKey(rng));
    expect(a).not.toEqual(b);
  });

  it("rejects vault keys that are not 32 bytes", () => {
    expect(() => deriveVaultIdFromKey(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
