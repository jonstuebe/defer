import {
  generateDeviceAuthToken,
  generateDeviceId,
  ready,
  sealForPairing,
} from "@defer/core/crypto";
import { PutPairingRequestSchema, RegisterDeviceRequestSchema } from "@defer/core/relay-protocol";

import type { StoragePort } from "../storage/index.js";
import { base64UrlToBytes, bytesToBase64Url } from "../util/base64.js";

const WIRE_TOKEN_BYTES = 16;

const SETTING_VAULT_KEY = "vault.keyBase64Url";
const SETTING_VAULT_ID = "vault.idBase64Url";

export type PairingTarget = {
  /** 32 random bytes — the new device's ephemeral X25519 pubkey. */
  recipientPubkey: Uint8Array;
  /** 22-char base64url pairing token chosen by the new device. */
  pairingToken: string;
  /** Display label for the confirm dialog (e.g., "Jon's iPhone"). */
  suggestedDeviceName: string;
  /** Coarse-grained classification (`desktop`, `mobile`, `extension`). */
  suggestedDeviceType: string;
};

export type ExecutePairingDeps = {
  storage: StoragePort;
  relayBaseUrl: string;
  /** Bearer used to authenticate the `POST /devices` registration call. */
  currentDeviceAuthToken: string;
  fetch?: typeof globalThis.fetch;
};

export type ExecutePairingResult = {
  /** 22-char base64url deviceId we minted for the new device. */
  newDeviceId: string;
  /** 22-char base64url deviceAuthToken we minted and sealed to the new device. */
  newDeviceAuthToken: string;
};

/**
 * Existing-device side of the pairing handshake.
 *
 * Per ADR-0003 §"Pairing handshake" and PRD §"Module factoring":
 * 1. Mint a fresh 32-byte (truncated to 16 wire-bytes) `deviceAuthToken`
 *    + 16-byte `deviceId` for the new device.
 * 2. Register the token at the relay (`POST /v1/vault/:vaultId/devices`)
 *    BEFORE posting the sealed blob — when the new device unseals and
 *    starts POSTing under the token, the relay must already accept it.
 * 3. Seal `(vaultKey, deviceAuthToken)` to the new device's ephemeral
 *    pubkey via `crypto_box_seal` and POST the sealed blob to
 *    `/v1/pairing` under the new-device-chosen pairing token (60s TTL
 *    per ADR-0003).
 *
 * Order matters: if (3) succeeded before (2), the new device would
 * briefly hold a token the relay refused. The reverse — (2) success
 * + (3) failure — leaves a dangling token the user can revoke from
 * Settings; safer than the alternative.
 */
export async function executePairing(
  target: PairingTarget,
  deps: ExecutePairingDeps,
): Promise<ExecutePairingResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  await ready;

  const vaultKeyB64 = await deps.storage.getSetting(SETTING_VAULT_KEY);
  const vaultIdB64 = await deps.storage.getSetting(SETTING_VAULT_ID);
  if (!vaultKeyB64 || !vaultIdB64) {
    throw new Error("executePairing: vault not initialized");
  }
  const vaultKey = base64UrlToBytes(vaultKeyB64);

  const newDeviceIdBytes = generateDeviceId();
  const newDeviceTokenBytes = generateDeviceAuthToken().slice(0, WIRE_TOKEN_BYTES);
  const newDeviceId = bytesToBase64Url(newDeviceIdBytes);
  const newDeviceAuthToken = bytesToBase64Url(newDeviceTokenBytes);

  // (2) Register the new token at the relay first.
  const registerBody = RegisterDeviceRequestSchema.parse({
    deviceId: newDeviceId,
    deviceAuthToken: newDeviceAuthToken,
  });
  const registerUrl = `${deps.relayBaseUrl.replace(/\/+$/, "")}/v1/vault/${vaultIdB64}/devices`;
  const registerResponse = await fetchImpl(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deps.currentDeviceAuthToken}`,
    },
    body: JSON.stringify(registerBody),
  });
  if (!registerResponse.ok) {
    throw new Error(`pairing: register failed with ${registerResponse.status}`);
  }

  // (3) Seal (vaultKey || deviceAuthToken) to the new device's pubkey.
  const payload = new Uint8Array(vaultKey.length + newDeviceTokenBytes.length);
  payload.set(vaultKey, 0);
  payload.set(newDeviceTokenBytes, vaultKey.length);
  const sealedBytes = sealForPairing(payload, target.recipientPubkey);

  // `PutPairingRequestSchema` expects standard base64 (not URL-safe).
  // Use the platform encoder.
  const sealedPayloadStandardBase64 = standardBase64FromBytes(sealedBytes);
  const putBody = PutPairingRequestSchema.parse({
    pairingToken: target.pairingToken,
    sealedPayload: sealedPayloadStandardBase64,
  });
  const pairUrl = `${deps.relayBaseUrl.replace(/\/+$/, "")}/v1/pairing`;
  const putResponse = await fetchImpl(pairUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!putResponse.ok) {
    throw new Error(`pairing: PUT /pairing failed with ${putResponse.status}`);
  }

  return { newDeviceId, newDeviceAuthToken };
}

function standardBase64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  // `btoa` produces standard base64 with padding — matches the
  // PutPairingRequestSchema regex `[A-Za-z0-9+/]+={0,2}`.
  return btoa(bin);
}
