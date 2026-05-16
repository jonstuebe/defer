import { sodium } from "./sodium.js";

const X25519_PUBLIC_KEY_BYTES = 32;
const X25519_PRIVATE_KEY_BYTES = 32;

export interface PairingKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateEphemeralPairingKeypair(): PairingKeypair {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function sealForPairing(payload: Uint8Array, recipientPubkey: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError("payload must be a Uint8Array");
  }
  if (
    !(recipientPubkey instanceof Uint8Array) ||
    recipientPubkey.length !== X25519_PUBLIC_KEY_BYTES
  ) {
    throw new RangeError(`recipientPubkey must be a ${X25519_PUBLIC_KEY_BYTES}-byte Uint8Array`);
  }
  return sodium.crypto_box_seal(payload, recipientPubkey);
}

export function openPairingSeal(sealed: Uint8Array, recipientKeypair: PairingKeypair): Uint8Array {
  if (!(sealed instanceof Uint8Array)) {
    throw new TypeError("sealed must be a Uint8Array");
  }
  if (
    !(recipientKeypair.publicKey instanceof Uint8Array) ||
    recipientKeypair.publicKey.length !== X25519_PUBLIC_KEY_BYTES
  ) {
    throw new RangeError(
      `recipientKeypair.publicKey must be a ${X25519_PUBLIC_KEY_BYTES}-byte Uint8Array`,
    );
  }
  if (
    !(recipientKeypair.privateKey instanceof Uint8Array) ||
    recipientKeypair.privateKey.length !== X25519_PRIVATE_KEY_BYTES
  ) {
    throw new RangeError(
      `recipientKeypair.privateKey must be a ${X25519_PRIVATE_KEY_BYTES}-byte Uint8Array`,
    );
  }
  return sodium.crypto_box_seal_open(
    sealed,
    recipientKeypair.publicKey,
    recipientKeypair.privateKey,
  );
}
