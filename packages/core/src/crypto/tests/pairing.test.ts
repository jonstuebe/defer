import { beforeAll, describe, expect, it } from "vitest";
import {
  generateEphemeralPairingKeypair,
  openPairingSeal,
  ready,
  sealForPairing,
} from "../index.js";

beforeAll(async () => {
  await ready;
});

describe("pairing seal", () => {
  it("round-trips a payload through seal + open with the matching keypair", () => {
    const kp = generateEphemeralPairingKeypair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);

    const payload = new TextEncoder().encode("vault-key || device-auth-token");
    const sealed = sealForPairing(payload, kp.publicKey);
    const opened = openPairingSeal(sealed, kp);

    expect(opened).toEqual(payload);
  });

  it("produces different ciphertexts for the same payload (ephemeral sender key)", () => {
    const kp = generateEphemeralPairingKeypair();
    const payload = new Uint8Array([1, 2, 3, 4]);

    const a = sealForPairing(payload, kp.publicKey);
    const b = sealForPairing(payload, kp.publicKey);

    expect(a).not.toEqual(b);
  });

  it("fails to open with a mismatched keypair", () => {
    const recipient = generateEphemeralPairingKeypair();
    const attacker = generateEphemeralPairingKeypair();
    const payload = new TextEncoder().encode("private");

    const sealed = sealForPairing(payload, recipient.publicKey);

    expect(() => openPairingSeal(sealed, attacker)).toThrow();
  });

  it("fails to open when the public/private halves are crossed", () => {
    const recipient = generateEphemeralPairingKeypair();
    const other = generateEphemeralPairingKeypair();
    const payload = new Uint8Array([0xff]);

    const sealed = sealForPairing(payload, recipient.publicKey);

    expect(() =>
      openPairingSeal(sealed, { publicKey: recipient.publicKey, privateKey: other.privateKey }),
    ).toThrow();
  });

  it("rejects malformed inputs", () => {
    const kp = generateEphemeralPairingKeypair();
    const payload = new Uint8Array([1]);

    expect(() => sealForPairing(payload, new Uint8Array(8))).toThrow(/recipientPubkey/);
    expect(() =>
      openPairingSeal(new Uint8Array(8), {
        publicKey: new Uint8Array(8),
        privateKey: kp.privateKey,
      }),
    ).toThrow();
  });
});
