import { beforeAll, describe, expect, it } from "vitest";
import { generateVaultKey, ready, signWithVaultKey, verifyVaultKeySignature } from "../index.js";

beforeAll(async () => {
  await ready;
});

describe("signWithVaultKey / verifyVaultKeySignature", () => {
  it("verifies a fresh signature with the matching key", () => {
    const k = generateVaultKey();
    const m = new TextEncoder().encode("VaultDeleted");
    const sig = signWithVaultKey(k, m);

    expect(sig.length).toBe(32);
    expect(verifyVaultKeySignature(k, m, sig)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const k = generateVaultKey();
    const m = new TextEncoder().encode("VaultDeletionScheduled");
    const sig = signWithVaultKey(k, m);

    const tampered = new Uint8Array(m);
    tampered[0]! ^= 0x01;
    expect(verifyVaultKeySignature(k, tampered, sig)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const k = generateVaultKey();
    const m = new TextEncoder().encode("hello");
    const sig = signWithVaultKey(k, m);

    const tampered = new Uint8Array(sig);
    tampered[tampered.length - 1]! ^= 0x80;
    expect(verifyVaultKeySignature(k, m, tampered)).toBe(false);
  });

  it("rejects verification with a different vault key", () => {
    const a = generateVaultKey();
    const b = generateVaultKey();
    const m = new TextEncoder().encode("vault-scoped message");
    const sig = signWithVaultKey(a, m);

    expect(verifyVaultKeySignature(b, m, sig)).toBe(false);
  });

  it("rejects signatures of the wrong length without throwing", () => {
    const k = generateVaultKey();
    const m = new Uint8Array([1, 2, 3]);
    expect(verifyVaultKeySignature(k, m, new Uint8Array(16))).toBe(false);
  });

  it("rejects malformed vault keys", () => {
    expect(() => signWithVaultKey(new Uint8Array(16), new Uint8Array(1))).toThrow(/32-byte/);
  });
});
