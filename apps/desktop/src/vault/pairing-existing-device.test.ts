import { describe, expect, it, vi } from "vitest";
import { generateEphemeralPairingKeypair, openPairingSeal, ready } from "@defer/core/crypto";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { createVault, persistVault } from "../onboarding/create-vault.js";
import { executePairing } from "./pairing-existing-device.js";
import { base64UrlToBytes } from "../util/base64.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function standardBase64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  const vault = await createVault();
  await persistVault(storage, vault, "Existing device");
  return { storage, vault };
}

describe("executePairing", () => {
  it("registers the new device + posts the sealed (vaultKey, deviceAuthToken) blob", async () => {
    const { storage, vault } = await setup();

    // Mock the new device's ephemeral keypair.
    const recipientKeypair = generateEphemeralPairingKeypair();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await executePairing(
      {
        recipientPubkey: recipientKeypair.publicKey,
        pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
        suggestedDeviceName: "New iPhone",
        suggestedDeviceType: "mobile",
      },
      {
        storage,
        relayBaseUrl: "https://relay.example",
        currentDeviceAuthToken: "currAAAAAAAAAAAAAAAAA",
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      },
    );

    // Order: POST /devices, then POST /pairing.
    const [registerCallUrl, registerInit] = fetchMock.mock.calls[0]!;
    expect(String(registerCallUrl)).toContain("/v1/vault/");
    expect(String(registerCallUrl)).toContain("/devices");
    expect((registerInit as RequestInit).method).toBe("POST");
    const registerBody = JSON.parse((registerInit as RequestInit).body as string);
    expect(registerBody.deviceId).toBe(result.newDeviceId);
    expect(registerBody.deviceAuthToken).toBe(result.newDeviceAuthToken);

    const [pairCallUrl, pairInit] = fetchMock.mock.calls[1]!;
    expect(String(pairCallUrl)).toContain("/v1/pairing");
    const pairBody = JSON.parse((pairInit as RequestInit).body as string);
    expect(pairBody.pairingToken).toBe("tok-AAAAAAAAAAAAAAAAAA");

    // Unseal and verify the payload contains (vaultKey, deviceAuthToken).
    const sealedBytes = standardBase64ToBytes(pairBody.sealedPayload);
    const opened = openPairingSeal(sealedBytes, recipientKeypair);
    expect(opened.length).toBe(vault.vaultKey.length + 16);
    expect(Array.from(opened.slice(0, vault.vaultKey.length))).toEqual(Array.from(vault.vaultKey));
    const sealedTokenBytes = opened.slice(vault.vaultKey.length);
    expect(Array.from(base64UrlToBytes(result.newDeviceAuthToken))).toEqual(
      Array.from(sealedTokenBytes),
    );
  });

  it("does NOT post sealed payload if registration fails", async () => {
    const { storage } = await setup();
    const recipientKeypair = generateEphemeralPairingKeypair();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(
      executePairing(
        {
          recipientPubkey: recipientKeypair.publicKey,
          pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
          suggestedDeviceName: "New iPhone",
          suggestedDeviceType: "mobile",
        },
        {
          storage,
          relayBaseUrl: "https://relay.example",
          currentDeviceAuthToken: "currAAAAAAAAAAAAAAAAA",
          fetch: fetchMock as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toThrow(/register failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires an initialized vault", async () => {
    const SQL = await initSqlForNode();
    const storage = new SqliteStorage(SQL);
    await storage.init();
    const recipientKeypair = generateEphemeralPairingKeypair();
    await expect(
      executePairing(
        {
          recipientPubkey: recipientKeypair.publicKey,
          pairingToken: "tok-AAAAAAAAAAAAAAAAAA",
          suggestedDeviceName: "X",
          suggestedDeviceType: "x",
        },
        {
          storage,
          relayBaseUrl: "https://relay.example",
          currentDeviceAuthToken: "currAAAAAAAAAAAAAAAAA",
          fetch: vi.fn() as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toThrow(/vault not initialized/);
  });
});
