import { describe, expect, it } from "vitest";

import { buildPairingQrPayload, parsePairingQrPayload } from "./pairing-qr.js";
import { base64UrlToBytes, bytesToBase64Url } from "../util/base64.js";

function makeValidPayload() {
  const pubkey = new Uint8Array(32).fill(0x11);
  return {
    pubkey,
    payload: buildPairingQrPayload({
      recipientPubkey: bytesToBase64Url(pubkey),
      pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
      deviceName: "Jon's iPhone",
      deviceType: "mobile",
    }),
  };
}

describe("parsePairingQrPayload", () => {
  it("round-trips a valid payload", () => {
    const { pubkey, payload } = makeValidPayload();
    const target = parsePairingQrPayload(payload);
    expect(Array.from(target.recipientPubkey)).toEqual(Array.from(pubkey));
    expect(target.pairingToken).toBe("tok-AAAAAAAAAAAAAAAAAA");
    expect(target.suggestedDeviceName).toBe("Jon's iPhone");
    expect(target.suggestedDeviceType).toBe("mobile");
  });

  it("rejects non-JSON input", () => {
    expect(() => parsePairingQrPayload("not json")).toThrow(/JSON/);
  });

  it("rejects unsupported version", () => {
    const bad = JSON.stringify({
      version: 2,
      recipientPubkey: bytesToBase64Url(new Uint8Array(32).fill(1)),
      pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
    });
    expect(() => parsePairingQrPayload(bad)).toThrow(/version/);
  });

  it("rejects a malformed recipientPubkey", () => {
    const bad = JSON.stringify({
      version: 1,
      recipientPubkey: "too-short",
      pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
    });
    expect(() => parsePairingQrPayload(bad)).toThrow(/recipientPubkey/);
  });

  it("rejects a malformed pairingToken", () => {
    const bad = JSON.stringify({
      version: 1,
      recipientPubkey: bytesToBase64Url(new Uint8Array(32).fill(1)),
      pairingToken: "bad",
    });
    expect(() => parsePairingQrPayload(bad)).toThrow(/pairingToken/);
  });

  it("clamps deviceName + deviceType to safe lengths", () => {
    const longName = "x".repeat(200);
    const bad = JSON.stringify({
      version: 1,
      recipientPubkey: bytesToBase64Url(new Uint8Array(32).fill(1)),
      pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
      deviceName: longName,
      deviceType: longName,
    });
    const target = parsePairingQrPayload(bad);
    expect(target.suggestedDeviceName.length).toBe(64);
    expect(target.suggestedDeviceType.length).toBe(32);
  });
});

describe("buildPairingQrPayload", () => {
  it("produces JSON parsable by parsePairingQrPayload", () => {
    const pubkey = new Uint8Array(32).fill(0x05);
    const json = buildPairingQrPayload({
      recipientPubkey: bytesToBase64Url(pubkey),
      pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
      deviceName: "Test",
      deviceType: "desktop",
    });
    const parsed = parsePairingQrPayload(json);
    expect(Array.from(parsed.recipientPubkey)).toEqual(Array.from(pubkey));
    // Verify the round-trip preserves the pubkey bytes via base64url too.
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(pubkey)))).toEqual(Array.from(pubkey));
  });
});
