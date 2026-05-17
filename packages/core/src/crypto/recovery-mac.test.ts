import { describe, expect, it } from "vitest";

import {
  computeRecoveryClaimMac,
  recoveryClaimCanonicalBytes,
  verifyRecoveryClaimMac,
} from "./recovery-mac.js";

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

const VAULT_KEY = bytes(32, 0x01);
const VAULT_ID = bytes(16, 0x02);
const CHALLENGE_NONCE = bytes(32, 0x03);
const DEVICE_ID = bytes(16, 0x04);
const DEVICE_AUTH_TOKEN = bytes(16, 0x05);

const INPUT = {
  vaultId: VAULT_ID,
  challengeNonce: CHALLENGE_NONCE,
  deviceId: DEVICE_ID,
  deviceAuthToken: DEVICE_AUTH_TOKEN,
};

describe("recoveryClaimCanonicalBytes", () => {
  it("prefixes the domain-separation string and concatenates fixed-length fields in ADR order", () => {
    const out = recoveryClaimCanonicalBytes(INPUT);
    const expectedPrefix = new TextEncoder().encode("defer-recovery-claim-v1");
    expect(Array.from(out.slice(0, expectedPrefix.length))).toEqual(Array.from(expectedPrefix));
    expect(out.length).toBe(expectedPrefix.length + 16 + 32 + 16 + 16);
  });

  it("rejects wrong-length fields", () => {
    expect(() => recoveryClaimCanonicalBytes({ ...INPUT, vaultId: bytes(15, 0) })).toThrow(
      /vaultId/,
    );
    expect(() => recoveryClaimCanonicalBytes({ ...INPUT, challengeNonce: bytes(31, 0) })).toThrow(
      /challengeNonce/,
    );
    expect(() => recoveryClaimCanonicalBytes({ ...INPUT, deviceId: bytes(15, 0) })).toThrow(
      /deviceId/,
    );
    expect(() => recoveryClaimCanonicalBytes({ ...INPUT, deviceAuthToken: bytes(15, 0) })).toThrow(
      /deviceAuthToken/,
    );
  });
});

describe("computeRecoveryClaimMac + verifyRecoveryClaimMac", () => {
  it("round-trips a valid MAC", () => {
    const mac = computeRecoveryClaimMac(VAULT_KEY, INPUT);
    expect(verifyRecoveryClaimMac(VAULT_KEY, INPUT, mac)).toBe(true);
  });

  it("rejects a MAC keyed by a different vault key", () => {
    const mac = computeRecoveryClaimMac(VAULT_KEY, INPUT);
    expect(verifyRecoveryClaimMac(bytes(32, 0x99), INPUT, mac)).toBe(false);
  });

  it("rejects a MAC over a different challenge nonce (replay defence)", () => {
    const mac = computeRecoveryClaimMac(VAULT_KEY, INPUT);
    const tamperedInput = { ...INPUT, challengeNonce: bytes(32, 0x33) };
    expect(verifyRecoveryClaimMac(VAULT_KEY, tamperedInput, mac)).toBe(false);
  });

  it("rejects a MAC of wrong length", () => {
    expect(verifyRecoveryClaimMac(VAULT_KEY, INPUT, bytes(31, 0))).toBe(false);
    expect(verifyRecoveryClaimMac(VAULT_KEY, INPUT, bytes(33, 0))).toBe(false);
  });

  it("rejects a wrong-length vault key", () => {
    expect(() => computeRecoveryClaimMac(bytes(31, 0), INPUT)).toThrow(/vaultKey/);
  });
});
