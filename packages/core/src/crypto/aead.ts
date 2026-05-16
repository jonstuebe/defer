import { assertReady, sodium } from "./sodium.js";

const VAULT_KEY_BYTES = 32;
const VAULT_ID_BYTES = 16;
const DEVICE_ID_BYTES = 16;
const NONCE_BYTES = 24;
const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER;

export interface EventAad {
  vaultId: Uint8Array;
  deviceId: Uint8Array;
  seq: number;
}

export interface EncryptEventOpts {
  vaultKey: Uint8Array;
  plaintext: Uint8Array;
  aad: EventAad;
}

export interface DecryptEventOpts {
  vaultKey: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  aad: EventAad;
}

export interface EncryptedEvent {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

function assertVaultKey(vaultKey: Uint8Array): void {
  if (!(vaultKey instanceof Uint8Array) || vaultKey.length !== VAULT_KEY_BYTES) {
    throw new RangeError(`vaultKey must be a ${VAULT_KEY_BYTES}-byte Uint8Array`);
  }
}

export function encodeEventAad(aad: EventAad): Uint8Array {
  if (!(aad.vaultId instanceof Uint8Array) || aad.vaultId.length !== VAULT_ID_BYTES) {
    throw new RangeError(`aad.vaultId must be a ${VAULT_ID_BYTES}-byte Uint8Array`);
  }
  if (!(aad.deviceId instanceof Uint8Array) || aad.deviceId.length !== DEVICE_ID_BYTES) {
    throw new RangeError(`aad.deviceId must be a ${DEVICE_ID_BYTES}-byte Uint8Array`);
  }
  if (!Number.isInteger(aad.seq) || aad.seq < 0 || aad.seq > MAX_SAFE_SEQ) {
    throw new RangeError("aad.seq must be a non-negative safe integer");
  }

  const out = new Uint8Array(VAULT_ID_BYTES + DEVICE_ID_BYTES + 8);
  out.set(aad.vaultId, 0);
  out.set(aad.deviceId, VAULT_ID_BYTES);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setBigUint64(VAULT_ID_BYTES + DEVICE_ID_BYTES, BigInt(aad.seq), false);
  return out;
}

export function encryptEvent(opts: EncryptEventOpts): EncryptedEvent {
  assertReady();
  assertVaultKey(opts.vaultKey);
  if (!(opts.plaintext instanceof Uint8Array)) {
    throw new TypeError("plaintext must be a Uint8Array");
  }
  const ad = encodeEventAad(opts.aad);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    opts.plaintext,
    ad,
    null,
    nonce,
    opts.vaultKey,
  );
  return { nonce, ciphertext };
}

export function decryptEvent(opts: DecryptEventOpts): Uint8Array {
  assertReady();
  assertVaultKey(opts.vaultKey);
  if (!(opts.nonce instanceof Uint8Array) || opts.nonce.length !== NONCE_BYTES) {
    throw new RangeError(`nonce must be a ${NONCE_BYTES}-byte Uint8Array`);
  }
  if (!(opts.ciphertext instanceof Uint8Array)) {
    throw new TypeError("ciphertext must be a Uint8Array");
  }
  const ad = encodeEventAad(opts.aad);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    opts.ciphertext,
    ad,
    opts.nonce,
    opts.vaultKey,
  );
}
