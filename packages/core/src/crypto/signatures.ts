import { sodium } from "./sodium.js";

const VAULT_KEY_BYTES = 32;
const HMAC_SHA256_BYTES = 32;

function assertVaultKey(vaultKey: Uint8Array): void {
  if (!(vaultKey instanceof Uint8Array) || vaultKey.length !== VAULT_KEY_BYTES) {
    throw new RangeError(`vaultKey must be a ${VAULT_KEY_BYTES}-byte Uint8Array`);
  }
}

export function signWithVaultKey(vaultKey: Uint8Array, message: Uint8Array): Uint8Array {
  assertVaultKey(vaultKey);
  if (!(message instanceof Uint8Array)) {
    throw new TypeError("message must be a Uint8Array");
  }
  return sodium.crypto_auth_hmacsha256(message, vaultKey);
}

export function verifyVaultKeySignature(
  vaultKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  assertVaultKey(vaultKey);
  if (!(message instanceof Uint8Array)) {
    throw new TypeError("message must be a Uint8Array");
  }
  if (!(signature instanceof Uint8Array) || signature.length !== HMAC_SHA256_BYTES) {
    return false;
  }
  return sodium.crypto_auth_hmacsha256_verify(signature, message, vaultKey);
}
