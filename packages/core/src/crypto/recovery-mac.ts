import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * MAC primitives for the vault-restoration handshake (ADR-0008).
 *
 * The MAC is HMAC-SHA256 keyed by the **Vault key** over canonical bytes
 * with a fixed domain-separation prefix. The relay never produces these
 * — it has no vault key — so all MAC computation lives client-side. The
 * relay forwards the MAC verbatim into a `DeviceRegistered` event for
 * replay-time verification by any other client that holds the vault key.
 */

const DOMAIN_SEP = new TextEncoder().encode("defer-recovery-claim-v1");

const VAULT_KEY_BYTES = 32;
const VAULT_ID_BYTES = 16;
const CHALLENGE_NONCE_BYTES = 32;
const DEVICE_ID_BYTES = 16;
const DEVICE_AUTH_TOKEN_BYTES = 16;

export type RecoveryClaimMacInput = {
  vaultId: Uint8Array;
  challengeNonce: Uint8Array;
  deviceId: Uint8Array;
  deviceAuthToken: Uint8Array;
};

function assertLengths(input: RecoveryClaimMacInput): void {
  if (input.vaultId.length !== VAULT_ID_BYTES) {
    throw new RangeError(`vaultId must be ${VAULT_ID_BYTES} bytes`);
  }
  if (input.challengeNonce.length !== CHALLENGE_NONCE_BYTES) {
    throw new RangeError(`challengeNonce must be ${CHALLENGE_NONCE_BYTES} bytes`);
  }
  if (input.deviceId.length !== DEVICE_ID_BYTES) {
    throw new RangeError(`deviceId must be ${DEVICE_ID_BYTES} bytes`);
  }
  if (input.deviceAuthToken.length !== DEVICE_AUTH_TOKEN_BYTES) {
    throw new RangeError(`deviceAuthToken must be ${DEVICE_AUTH_TOKEN_BYTES} bytes`);
  }
}

/**
 * Concatenates the canonical bytes per ADR-0008:
 *
 *     "defer-recovery-claim-v1" ‖ vaultId ‖ challengeNonce ‖ deviceId ‖ deviceAuthToken
 *
 * No length prefixes — every field is fixed-length and the order is
 * unambiguous, matching the ADR's "no length prefixes needed" note.
 */
export function recoveryClaimCanonicalBytes(input: RecoveryClaimMacInput): Uint8Array {
  assertLengths(input);
  const totalLength =
    DOMAIN_SEP.length +
    VAULT_ID_BYTES +
    CHALLENGE_NONCE_BYTES +
    DEVICE_ID_BYTES +
    DEVICE_AUTH_TOKEN_BYTES;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  out.set(DOMAIN_SEP, offset);
  offset += DOMAIN_SEP.length;
  out.set(input.vaultId, offset);
  offset += VAULT_ID_BYTES;
  out.set(input.challengeNonce, offset);
  offset += CHALLENGE_NONCE_BYTES;
  out.set(input.deviceId, offset);
  offset += DEVICE_ID_BYTES;
  out.set(input.deviceAuthToken, offset);
  return out;
}

export function computeRecoveryClaimMac(
  vaultKey: Uint8Array,
  input: RecoveryClaimMacInput,
): Uint8Array {
  if (vaultKey.length !== VAULT_KEY_BYTES) {
    throw new RangeError(`vaultKey must be ${VAULT_KEY_BYTES} bytes`);
  }
  const message = recoveryClaimCanonicalBytes(input);
  return hmac(sha256, vaultKey, message);
}

/**
 * Constant-time MAC comparison — important because clients verify MACs
 * over attacker-controlled payloads (the relay-forwarded `recoveryClaim`
 * fields on a `DeviceRegistered` event).
 */
export function verifyRecoveryClaimMac(
  vaultKey: Uint8Array,
  input: RecoveryClaimMacInput,
  candidateMac: Uint8Array,
): boolean {
  const expected = computeRecoveryClaimMac(vaultKey, input);
  if (expected.length !== candidateMac.length) return false;
  let acc = 0;
  for (let i = 0; i < expected.length; i += 1) {
    acc |= expected[i]! ^ candidateMac[i]!;
  }
  return acc === 0;
}
