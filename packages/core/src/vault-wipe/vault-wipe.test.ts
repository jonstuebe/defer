import { describe, expect, it } from "vitest";
import { ready, signWithVaultKey, generateVaultKey } from "../crypto/index.js";
import { envelopeForSigning } from "../crypto/canonical-bytes.js";
import { RELAY_DEVICE_ID, type VaultDeleted } from "../events/index.js";

import { verifyVaultDeleted } from "./vault-wipe.js";

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function makeSignedDeletedEvent(opts: {
  vaultKey?: Uint8Array;
  deviceId?: string;
  deletedAt?: number;
}): Promise<{ event: VaultDeleted; vaultKey: Uint8Array }> {
  await ready;
  const vaultKey = opts.vaultKey ?? generateVaultKey();
  const unsigned = {
    type: "VaultDeleted" as const,
    seq: 100,
    deviceId: opts.deviceId ?? RELAY_DEVICE_ID,
    timestamp: 1_700_000_000_000,
    clientNonce: "AAAAAAAAAAAAAAAAAAAAAA",
    data: { deletedAt: opts.deletedAt ?? 1_700_000_000_999 },
  };
  const sig = signWithVaultKey(
    vaultKey,
    envelopeForSigning(unsigned as unknown as Record<string, unknown>),
  );
  const event = { ...unsigned, signature: bytesToBase64Url(sig) } as VaultDeleted;
  return { event, vaultKey };
}

describe("verifyVaultDeleted", () => {
  it("accepts a valid event with deviceId = RELAY_DEVICE_ID + correct MAC", async () => {
    const { event, vaultKey } = await makeSignedDeletedEvent({});
    const result = verifyVaultDeleted(vaultKey, event);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deletedAt).toBe(1_700_000_000_999);
  });

  it("refuses an event whose deviceId is not RELAY_DEVICE_ID (forged source)", async () => {
    const { event, vaultKey } = await makeSignedDeletedEvent({
      deviceId: "real-deviceAAAAAAAAAA",
    });
    const result = verifyVaultDeleted(vaultKey, event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong-device-id");
  });

  it("refuses an event signed with the wrong vault key", async () => {
    const { event } = await makeSignedDeletedEvent({});
    const otherKey = generateVaultKey();
    const result = verifyVaultDeleted(otherKey, event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-signature");
  });

  it("refuses an event whose payload bytes have been tampered with", async () => {
    const { event, vaultKey } = await makeSignedDeletedEvent({});
    const tampered = { ...event, data: { deletedAt: 1 } };
    const result = verifyVaultDeleted(vaultKey, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-signature");
  });
});
