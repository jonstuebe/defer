import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const VAULT_KEY_LENGTH = 32;
const VAULT_ID_LENGTH = 16;
const MNEMONIC_WORD_COUNT = 24;
const VAULT_ID_HKDF_SALT = Uint8Array.from("defer-vault-id", (c) => c.charCodeAt(0));

const WORDLIST_SET: ReadonlySet<string> = new Set(wordlist);

function normalizeMnemonic(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("recoveryMnemonic: expected a string");
  }
  return input.normalize("NFKD").trim().split(/\s+/).join(" ");
}

export function encodeVaultKey(vaultKey: Uint8Array): string {
  if (!(vaultKey instanceof Uint8Array)) {
    throw new TypeError("encodeVaultKey: vaultKey must be a Uint8Array");
  }
  if (vaultKey.length !== VAULT_KEY_LENGTH) {
    throw new RangeError(
      `encodeVaultKey: vaultKey must be ${VAULT_KEY_LENGTH} bytes, got ${vaultKey.length}`,
    );
  }
  return entropyToMnemonic(vaultKey, wordlist);
}

export function decodeMnemonic(mnemonic: string): Uint8Array {
  const normalized = normalizeMnemonic(mnemonic);
  const words = normalized.split(" ");

  if (words.length !== MNEMONIC_WORD_COUNT) {
    throw new Error(`decodeMnemonic: expected ${MNEMONIC_WORD_COUNT} words, got ${words.length}`);
  }

  const unknown = words.find((word) => !WORDLIST_SET.has(word));
  if (unknown !== undefined) {
    throw new Error(`decodeMnemonic: word "${unknown}" is not in the BIP-39 English wordlist`);
  }

  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(normalized, wordlist);
  } catch {
    throw new Error("decodeMnemonic: invalid BIP-39 checksum");
  }

  if (entropy.length !== VAULT_KEY_LENGTH) {
    throw new Error(
      `decodeMnemonic: decoded entropy is ${entropy.length} bytes, expected ${VAULT_KEY_LENGTH}`,
    );
  }
  return entropy;
}

export function deriveVaultIdFromKey(vaultKey: Uint8Array): Uint8Array {
  if (!(vaultKey instanceof Uint8Array)) {
    throw new TypeError("deriveVaultIdFromKey: vaultKey must be a Uint8Array");
  }
  if (vaultKey.length !== VAULT_KEY_LENGTH) {
    throw new RangeError(
      `deriveVaultIdFromKey: vaultKey must be ${VAULT_KEY_LENGTH} bytes, got ${vaultKey.length}`,
    );
  }
  return hkdf(sha256, vaultKey, VAULT_ID_HKDF_SALT, undefined, VAULT_ID_LENGTH);
}
