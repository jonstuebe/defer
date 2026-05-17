import { BIP39_ENGLISH_WORDLIST } from "@defer/core";

export const BIP39_WORDLIST: readonly string[] = BIP39_ENGLISH_WORDLIST;
export const BIP39_WORDLIST_SET: ReadonlySet<string> = new Set(BIP39_ENGLISH_WORDLIST);

/**
 * Returns up to `limit` BIP-39 words that start with `prefix` (lowercase
 * trimmed). Used by the recovery-mnemonic input's autocomplete (PRD US #9).
 * Empty prefix returns an empty list — we don't want to flood the UI
 * when the user hasn't typed anything yet.
 */
export function suggestBip39Words(prefix: string, limit: number = 5): string[] {
  const q = prefix.trim().toLowerCase();
  if (q === "") return [];
  const hits: string[] = [];
  for (const word of BIP39_WORDLIST) {
    if (word.startsWith(q)) {
      hits.push(word);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export function isBip39Word(word: string): boolean {
  return BIP39_WORDLIST_SET.has(word.trim().toLowerCase());
}
