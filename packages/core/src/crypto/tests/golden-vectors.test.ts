import { beforeAll, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import {
  decryptEvent,
  encodeEventAad,
  ready,
  signWithVaultKey,
  verifyVaultKeySignature,
} from "../index.js";

beforeAll(async () => {
  await ready;
});

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function rangeBytes(length: number, start = 0, step = 1, mod = 256): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (start + i * step) % mod;
  return out;
}

// Golden AEAD vectors: fixed (vaultKey, nonce, plaintext, aad) -> fixed ciphertext.
// These vectors document the wire format for cross-implementation parity:
// libsodium-wrappers-sumo (this package), react-native-libsodium (Phase 5),
// and dryoc (Phase 3) must all produce/accept identical ciphertexts.
// AAD is serialized as: vaultId(16) || deviceId(16) || clientNonce(16) — pinned
// by ADR-0006 §4. Total AAD length is 48 bytes.
interface AeadVector {
  name: string;
  vaultKey: Uint8Array;
  nonce: Uint8Array;
  vaultId: Uint8Array;
  deviceId: Uint8Array;
  clientNonce: Uint8Array;
  plaintext: Uint8Array;
  ciphertextHex: string;
}

const aeadVectors: AeadVector[] = [
  {
    name: "empty plaintext, low-entropy fixed inputs",
    vaultKey: rangeBytes(32),
    nonce: rangeBytes(24, 0x40),
    vaultId: new Uint8Array(16).fill(0xaa),
    deviceId: new Uint8Array(16).fill(0xbb),
    clientNonce: new Uint8Array(16).fill(0x11),
    plaintext: new Uint8Array(0),
    ciphertextHex: "f6134bf8a207414d6bd8397dece4745e",
  },
  {
    name: "short ASCII plaintext, mid-entropy nonce",
    vaultKey: rangeBytes(32, 0, 7),
    nonce: rangeBytes(24, 0, 11),
    vaultId: rangeBytes(16),
    deviceId: rangeBytes(16, 0x80),
    clientNonce: rangeBytes(16, 0x10, 3),
    plaintext: new TextEncoder().encode("defer test vector"),
    ciphertextHex: "73c43676cffe822c4f3fd8a348c6238b3e2a6dabcaf68afb4c68c01b676fcd238d",
  },
  {
    name: "100-byte payload, fixed-fill inputs",
    vaultKey: new Uint8Array(32).fill(0x55),
    nonce: new Uint8Array(24).fill(0x33),
    vaultId: new Uint8Array(16).fill(0xcc),
    deviceId: new Uint8Array(16).fill(0xdd),
    clientNonce: new Uint8Array(16).fill(0xee),
    plaintext: rangeBytes(100),
    ciphertextHex:
      "ad9920f2d6d062db926832450f8eebbebe249b5841b30bb617cda89bfe5f215eab4ae620ed7c78472f55ad8c514c4c6a1408a1a3c1d988a73d40f55fd85f2b2e8b4818ff1b8585ebfa8e77977d5a2d08f10dbd9888a75c14f096bdfd796f1df08e128cf94aa3142f8c14b59f669942c42f2349ac",
  },
];

describe("AEAD golden vectors (cross-implementation parity)", () => {
  for (const v of aeadVectors) {
    it(`encrypts ${v.name} to the documented ciphertext`, () => {
      const ad = encodeEventAad({
        vaultId: v.vaultId,
        deviceId: v.deviceId,
        clientNonce: v.clientNonce,
      });
      const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        v.plaintext,
        ad,
        null,
        v.nonce,
        v.vaultKey,
      );
      expect(ct).toEqual(hex(v.ciphertextHex));
    });

    it(`decrypts ${v.name} via decryptEvent`, () => {
      const out = decryptEvent({
        vaultKey: v.vaultKey,
        nonce: v.nonce,
        ciphertext: hex(v.ciphertextHex),
        aad: { vaultId: v.vaultId, deviceId: v.deviceId, clientNonce: v.clientNonce },
      });
      expect(out).toEqual(v.plaintext);
    });
  }
});

describe("HMAC-SHA256 golden vector", () => {
  it("signs the documented message under the documented key to the documented tag", () => {
    const k = rangeBytes(32);
    const m = new TextEncoder().encode("VaultDeleted");
    const sig = signWithVaultKey(k, m);
    expect(sig).toEqual(hex("e0a249311c9741731ffbc158681093242cd31a52b43b3b488eda6cf3be3cb9fd"));
    expect(verifyVaultKeySignature(k, m, sig)).toBe(true);
  });
});
