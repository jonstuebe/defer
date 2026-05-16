import { describe, expect, it, vi } from "vitest";

// Hold sodium.ready in a pending state for the whole file so `initialized`
// in sodium.ts stays false and assertReady() can be observed throwing.
vi.mock("libsodium-wrappers-sumo", () => ({
  default: {
    ready: new Promise<void>(() => {}),
    randombytes_buf: () => new Uint8Array(0),
    crypto_box_keypair: () => ({
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
      keyType: "x25519",
    }),
    crypto_box_seal: () => new Uint8Array(0),
    crypto_box_seal_open: () => new Uint8Array(0),
    crypto_aead_xchacha20poly1305_ietf_encrypt: () => new Uint8Array(0),
    crypto_aead_xchacha20poly1305_ietf_decrypt: () => new Uint8Array(0),
    crypto_auth_hmacsha256: () => new Uint8Array(32),
    crypto_auth_hmacsha256_verify: () => true,
  },
}));

describe("ready guard", () => {
  it("throws a friendly error when generateVaultKey is called before ready", async () => {
    const { generateVaultKey } = await import("../index.js");
    expect(() => generateVaultKey()).toThrow(/not initialized.*await ready/);
  });

  it("throws when generateDeviceId is called before ready", async () => {
    const { generateDeviceId } = await import("../index.js");
    expect(() => generateDeviceId()).toThrow(/not initialized/);
  });

  it("throws when generateDeviceAuthToken is called before ready", async () => {
    const { generateDeviceAuthToken } = await import("../index.js");
    expect(() => generateDeviceAuthToken()).toThrow(/not initialized/);
  });

  it("throws when encryptEvent is called before ready", async () => {
    const { encryptEvent } = await import("../index.js");
    expect(() =>
      encryptEvent({
        vaultKey: new Uint8Array(32),
        plaintext: new Uint8Array(0),
        aad: { vaultId: new Uint8Array(16), deviceId: new Uint8Array(16), seq: 0 },
      }),
    ).toThrow(/not initialized/);
  });

  it("throws when decryptEvent is called before ready", async () => {
    const { decryptEvent } = await import("../index.js");
    expect(() =>
      decryptEvent({
        vaultKey: new Uint8Array(32),
        nonce: new Uint8Array(24),
        ciphertext: new Uint8Array(16),
        aad: { vaultId: new Uint8Array(16), deviceId: new Uint8Array(16), seq: 0 },
      }),
    ).toThrow(/not initialized/);
  });

  it("throws when generateEphemeralPairingKeypair is called before ready", async () => {
    const { generateEphemeralPairingKeypair } = await import("../index.js");
    expect(() => generateEphemeralPairingKeypair()).toThrow(/not initialized/);
  });

  it("throws when sealForPairing is called before ready", async () => {
    const { sealForPairing } = await import("../index.js");
    expect(() => sealForPairing(new Uint8Array(0), new Uint8Array(32))).toThrow(/not initialized/);
  });

  it("throws when openPairingSeal is called before ready", async () => {
    const { openPairingSeal } = await import("../index.js");
    expect(() =>
      openPairingSeal(new Uint8Array(0), {
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
      }),
    ).toThrow(/not initialized/);
  });

  it("throws when signWithVaultKey is called before ready", async () => {
    const { signWithVaultKey } = await import("../index.js");
    expect(() => signWithVaultKey(new Uint8Array(32), new Uint8Array(0))).toThrow(
      /not initialized/,
    );
  });

  it("throws when verifyVaultKeySignature is called before ready", async () => {
    const { verifyVaultKeySignature } = await import("../index.js");
    expect(() =>
      verifyVaultKeySignature(new Uint8Array(32), new Uint8Array(0), new Uint8Array(32)),
    ).toThrow(/not initialized/);
  });
});
