import { describe, expect, it, vi } from "vitest";
import { ready, computeRecoveryClaimMac, generateVaultKey } from "@defer/core/crypto";
import { deriveVaultIdFromKey, encodeVaultKey } from "@defer/core";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import { restoreFromMnemonic } from "./restore-vault.js";
import { base64UrlToBytes, bytesToBase64Url } from "../util/base64.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function setup() {
  await ready;
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  return { storage };
}

describe("restoreFromMnemonic", () => {
  it("completes the ADR-0008 handshake: GET challenge then POST claim with vault-key MAC", async () => {
    const { storage } = await setup();
    const vaultKey = generateVaultKey();
    const mnemonic = encodeVaultKey(vaultKey);

    const challengeNonce = new Uint8Array(32);
    crypto.getRandomValues(challengeNonce);
    const challengeNonceB64 = bytesToBase64Url(challengeNonce);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          challengeNonce: challengeNonceB64,
          expiresAt: Date.now() + 60_000,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, assignedSeq: 1 }));

    const { vault, recoveryClaim } = await restoreFromMnemonic(mnemonic, {
      storage,
      relayBaseUrl: "https://relay.example",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    // Same vault key recovered.
    expect(Array.from(vault.vaultKey)).toEqual(Array.from(vaultKey));
    // Same vault ID derived.
    expect(Array.from(vault.vaultId)).toEqual(Array.from(deriveVaultIdFromKey(vaultKey)));

    // POST URL + body shape correct.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, postArgs] = fetchMock.mock.calls[1]!;
    const postUrl = fetchMock.mock.calls[1]![0] as string;
    expect(postUrl).toContain("/recovery-claim");
    const postBody = JSON.parse((postArgs as RequestInit).body as string);
    expect(postBody.challengeNonce).toBe(challengeNonceB64);

    // MAC verifies under the vault key.
    const macBytes = base64UrlToBytes(postBody.mac);
    const expectedMac = computeRecoveryClaimMac(vaultKey, {
      vaultId: vault.vaultId,
      challengeNonce,
      deviceId: base64UrlToBytes(postBody.deviceId),
      deviceAuthToken: base64UrlToBytes(postBody.deviceAuthToken),
    });
    expect(Array.from(macBytes)).toEqual(Array.from(expectedMac));

    // recoveryClaim returned to the caller matches what we POSTed.
    expect(recoveryClaim.challengeNonce).toBe(challengeNonceB64);
  });

  it("rejects a mnemonic with an invalid BIP-39 checksum", async () => {
    const { storage } = await setup();
    const fetchMock = vi.fn();
    await expect(
      restoreFromMnemonic(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zoo",
        {
          storage,
          relayBaseUrl: "https://relay.example",
          fetch: fetchMock as unknown as typeof globalThis.fetch,
        },
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a non-2xx from /recovery-challenge", async () => {
    const { storage } = await setup();
    const vaultKey = generateVaultKey();
    const mnemonic = encodeVaultKey(vaultKey);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(
      restoreFromMnemonic(mnemonic, {
        storage,
        relayBaseUrl: "https://relay.example",
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/recovery-challenge failed/);
  });
});
