import { beforeAll, describe, expect, it } from "vitest";
import {
  decryptEvent,
  encodeEventAad,
  encryptEvent,
  generateDeviceId,
  generateVaultKey,
  ready,
} from "../index.js";

beforeAll(async () => {
  await ready;
});

function vaultId(): Uint8Array {
  return new Uint8Array(16).fill(0xaa);
}

function deviceId(): Uint8Array {
  return new Uint8Array(16).fill(0xbb);
}

function clientNonce(fill = 0xcc): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

describe("encryptEvent / decryptEvent", () => {
  it("round-trips plaintext with matching AAD", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new TextEncoder().encode("hello defer");
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x01) };

    const { nonce, ciphertext } = encryptEvent({ vaultKey, plaintext, aad });
    const out = decryptEvent({ vaultKey, nonce, ciphertext, aad });

    expect(out).toEqual(plaintext);
  });

  it("returns a 24-byte nonce and a ciphertext longer than the plaintext (auth tag attached)", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new Uint8Array(64);
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x02) };

    const { nonce, ciphertext } = encryptEvent({ vaultKey, plaintext, aad });

    expect(nonce.length).toBe(24);
    expect(ciphertext.length).toBe(plaintext.length + 16);
  });

  it("uses a fresh random nonce per encrypt call", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new TextEncoder().encode("same message");
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x03) };

    const a = encryptEvent({ vaultKey, plaintext, aad });
    const b = encryptEvent({ vaultKey, plaintext, aad });

    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("throws when AAD vaultId is tampered (relay reorder defence)", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new TextEncoder().encode("payload");
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x04) };

    const { nonce, ciphertext } = encryptEvent({ vaultKey, plaintext, aad });

    const tampered = { ...aad, vaultId: new Uint8Array(aad.vaultId) };
    tampered.vaultId[0]! ^= 0x01;

    expect(() => decryptEvent({ vaultKey, nonce, ciphertext, aad: tampered })).toThrow();
  });

  it("throws when AAD deviceId is tampered", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new Uint8Array([1, 2, 3]);
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x05) };

    const { nonce, ciphertext } = encryptEvent({ vaultKey, plaintext, aad });

    const tampered = { ...aad, deviceId: new Uint8Array(aad.deviceId) };
    tampered.deviceId[5]! ^= 0x80;

    expect(() => decryptEvent({ vaultKey, nonce, ciphertext, aad: tampered })).toThrow();
  });

  it("throws when AAD clientNonce is tampered (replay defence)", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new Uint8Array([9, 9, 9]);
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x06) };

    const { nonce, ciphertext } = encryptEvent({ vaultKey, plaintext, aad });

    const tampered = { ...aad, clientNonce: new Uint8Array(aad.clientNonce) };
    tampered.clientNonce[0]! ^= 0x01;

    expect(() => decryptEvent({ vaultKey, nonce, ciphertext, aad: tampered })).toThrow();
  });

  it("throws when decrypted with a different vault key", () => {
    const vaultKey = generateVaultKey();
    const wrongKey = generateVaultKey();
    const plaintext = new TextEncoder().encode("secret");
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x07) };

    const { nonce, ciphertext } = encryptEvent({ vaultKey, plaintext, aad });

    expect(() => decryptEvent({ vaultKey: wrongKey, nonce, ciphertext, aad })).toThrow();
  });

  it("throws when ciphertext is bit-flipped", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new TextEncoder().encode("integrity matters");
    const aad = { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce(0x08) };

    const { nonce, ciphertext } = encryptEvent({ vaultKey, plaintext, aad });
    const corrupted = new Uint8Array(ciphertext);
    corrupted[0]! ^= 0x01;

    expect(() => decryptEvent({ vaultKey, nonce, ciphertext: corrupted, aad })).toThrow();
  });

  it("rejects malformed vault keys and AAD shapes", () => {
    const vaultKey = generateVaultKey();
    const plaintext = new Uint8Array(1);

    expect(() =>
      encryptEvent({
        vaultKey: new Uint8Array(16),
        plaintext,
        aad: { vaultId: vaultId(), deviceId: deviceId(), clientNonce: clientNonce() },
      }),
    ).toThrow(/32-byte/);

    expect(() =>
      encryptEvent({
        vaultKey,
        plaintext,
        aad: { vaultId: new Uint8Array(8), deviceId: deviceId(), clientNonce: clientNonce() },
      }),
    ).toThrow(/vaultId/);

    expect(() =>
      encryptEvent({
        vaultKey,
        plaintext,
        aad: { vaultId: vaultId(), deviceId: new Uint8Array(8), clientNonce: clientNonce() },
      }),
    ).toThrow(/deviceId/);

    expect(() =>
      encryptEvent({
        vaultKey,
        plaintext,
        aad: { vaultId: vaultId(), deviceId: deviceId(), clientNonce: new Uint8Array(8) },
      }),
    ).toThrow(/clientNonce/);
  });

  it("encodeEventAad concatenates vaultId || deviceId || clientNonce (16+16+16)", () => {
    const encoded = encodeEventAad({
      vaultId: new Uint8Array(16).fill(0x11),
      deviceId: new Uint8Array(16).fill(0x22),
      clientNonce: new Uint8Array(16).fill(0x33),
    });

    expect(encoded.length).toBe(16 + 16 + 16);
    expect(Array.from(encoded.slice(0, 16))).toEqual(Array(16).fill(0x11));
    expect(Array.from(encoded.slice(16, 32))).toEqual(Array(16).fill(0x22));
    expect(Array.from(encoded.slice(32, 48))).toEqual(Array(16).fill(0x33));
  });

  it("generates distinct device ids across calls", () => {
    const a = generateDeviceId();
    const b = generateDeviceId();
    expect(a.length).toBe(16);
    expect(b.length).toBe(16);
    expect(a).not.toEqual(b);
  });
});
