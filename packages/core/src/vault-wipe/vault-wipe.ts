import { envelopeForSigning, verifyVaultKeySignature } from "../crypto/index.js";
import { RELAY_DEVICE_ID, type VaultDeleted } from "../events/index.js";

export type WipeResult =
  | { ok: true; deletedAt: number }
  | { ok: false; reason: "invalid-signature" | "wrong-device-id" | "schema" };

/**
 * Verifies a `VaultDeleted` event arrived legitimately before triggering
 * any destructive action (ADR-0005 §"signature-on-replay" + ADR-0006 §5 +
 * PRD US #15 — "I want clients to refuse to wipe local data unless the
 * deletion event carries a valid signature against my vault key, so that
 * a compromised relay cannot weaponize the wipe trigger against me").
 *
 * Two layers of defence:
 * 1. `event.deviceId === RELAY_DEVICE_ID` — only the relay (via its DO
 *    deletion alarm) is meant to emit this event. A forged event with
 *    a real `deviceId` is rejected here.
 * 2. The MAC over the canonical envelope-without-(signature, seq)
 *    verifies under the vault key. Without the vault key the relay
 *    cannot forge this MAC (blind-relay invariant, ADR-0001).
 *
 * Returns a discriminated result rather than throwing — callers (the
 * desktop's `vaultWipe.execute`) need to surface the rejection to the
 * user without crashing.
 */
export function verifyVaultDeleted(vaultKey: Uint8Array, event: VaultDeleted): WipeResult {
  if (event.deviceId !== RELAY_DEVICE_ID) {
    return { ok: false, reason: "wrong-device-id" };
  }
  const bytesToVerify = envelopeForSigning(event as unknown as Record<string, unknown>);
  const sig = base64UrlToBytes(event.signature);
  if (!verifyVaultKeySignature(vaultKey, bytesToVerify, sig)) {
    return { ok: false, reason: "invalid-signature" };
  }
  return { ok: true, deletedAt: event.data.deletedAt };
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  // The `atob` polyfill is platform-provided everywhere we run
  // (Node 22+ + browsers + Tauri webview).
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
