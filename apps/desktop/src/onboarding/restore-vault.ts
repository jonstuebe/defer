import {
  computeRecoveryClaimMac,
  generateDeviceAuthToken,
  generateDeviceId,
  ready,
} from "@defer/core/crypto";
import {
  RecoveryChallengeResponseSchema,
  RecoveryClaimResponseSchema,
} from "@defer/core/relay-protocol";
import { decodeMnemonic, deriveVaultIdFromKey } from "@defer/core";

import { base64UrlToBytes, bytesToBase64Url } from "../util/base64.js";
import type { StoragePort } from "../storage/index.js";
import { persistVault, type CreatedVault } from "./create-vault.js";

const WIRE_TOKEN_BYTES = 16;

export type RestorationStep =
  | { kind: "validating-mnemonic" }
  | { kind: "requesting-challenge" }
  | { kind: "claiming-device" }
  | { kind: "replaying"; applied: number }
  | { kind: "complete" };

export type RestoreFromMnemonicDeps = {
  storage: StoragePort;
  relayBaseUrl: string;
  /** Fetch implementation — tests pass a mock; production uses `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  onProgress?: (step: RestorationStep) => void;
};

/**
 * Implements the desktop side of ADR-0008's recovery handshake.
 *
 * Returns a `CreatedVault` once the relay accepts the claim. The caller
 * (UI flow in `App.tsx`) then commits via `persistVault` and triggers
 * the full event-log replay through `InboundReplay` from `since = 0`.
 *
 * Replay itself is the caller's responsibility — `InboundReplay` already
 * knows how to apply events from `seq > since` and report progress.
 * This function only owns the auth handshake.
 */
export async function restoreFromMnemonic(
  mnemonic: string,
  deps: RestoreFromMnemonicDeps,
): Promise<{ vault: CreatedVault; recoveryClaim: RecoveryClaim }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  deps.onProgress?.({ kind: "validating-mnemonic" });
  await ready;

  // BIP-39 decode rejects checksums + bad words. Throws with a clear
  // message that bubbles up to the UI's inline error label.
  const vaultKey = decodeMnemonic(mnemonic);
  const vaultId = deriveVaultIdFromKey(vaultKey);
  const vaultIdBase64Url = bytesToBase64Url(vaultId);

  // Mint a fresh device identity. Per ADR-0008 the deviceAuthToken is
  // 16 bytes (22-char base64url). Same shape as elsewhere in v1 — see
  // `vault/relay-config.ts` for the truncation rationale.
  const deviceIdBytes = generateDeviceId();
  const deviceAuthTokenBytes = generateDeviceAuthToken().slice(0, WIRE_TOKEN_BYTES);
  const deviceId = bytesToBase64Url(deviceIdBytes);
  const deviceAuthToken = bytesToBase64Url(deviceAuthTokenBytes);

  deps.onProgress?.({ kind: "requesting-challenge" });
  const challenge = await fetchChallenge(fetchImpl, deps.relayBaseUrl, vaultIdBase64Url);
  const challengeNonceBytes = base64UrlToBytes(challenge.challengeNonce);

  const mac = computeRecoveryClaimMac(vaultKey, {
    vaultId,
    challengeNonce: challengeNonceBytes,
    deviceId: deviceIdBytes,
    deviceAuthToken: deviceAuthTokenBytes,
  });

  deps.onProgress?.({ kind: "claiming-device" });
  await postClaim(fetchImpl, deps.relayBaseUrl, vaultIdBase64Url, {
    challengeNonce: challenge.challengeNonce,
    deviceId,
    deviceAuthToken,
    mac: bytesToBase64Url(mac),
  });

  await persistVault(
    deps.storage,
    {
      vaultKey,
      vaultId,
      mnemonic,
      deviceId,
    },
    "Restored device",
  );
  await deps.storage.setSetting("device.authTokenBase64Url", deviceAuthToken);

  return {
    vault: { vaultKey, vaultId, mnemonic, deviceId },
    recoveryClaim: {
      challengeNonce: challenge.challengeNonce,
      mac: bytesToBase64Url(mac),
    },
  };
}

export type RecoveryClaim = {
  challengeNonce: string;
  mac: string;
};

async function fetchChallenge(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  vaultIdBase64Url: string,
) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/vault/${vaultIdBase64Url}/recovery-challenge`;
  const response = await fetchImpl(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`recovery-challenge failed: ${response.status}`);
  }
  const body = await response.json();
  return RecoveryChallengeResponseSchema.parse(body);
}

async function postClaim(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  vaultIdBase64Url: string,
  body: {
    challengeNonce: string;
    deviceId: string;
    deviceAuthToken: string;
    mac: string;
  },
) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/vault/${vaultIdBase64Url}/recovery-claim`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`recovery-claim failed: ${response.status}`);
  }
  const parsed = RecoveryClaimResponseSchema.parse(await response.json());
  return parsed;
}
