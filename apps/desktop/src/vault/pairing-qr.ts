import { base64UrlToBytes } from "../util/base64.js";
import type { PairingTarget } from "./pairing-existing-device.js";

/**
 * Wire format for the new device's pairing QR / typed code.
 *
 * Slice #57 commits to a JSON shape carried as text in the QR. The new
 * device builds it; the existing device parses it. Going JSON-text
 * rather than a binary blob keeps the QR + typed-code paths identical —
 * the typed-code variant is just the same JSON pasted by the user.
 *
 * Forward-compat: extra fields are tolerated; only the required four
 * are validated. A future protocol bump can rev `version`.
 */
type PairingQrPayload = {
  version: 1;
  /** 32-byte X25519 pubkey, 43-char base64url. */
  recipientPubkey: string;
  /** 22-char base64url one-time token shared with the relay. */
  pairingToken: string;
  /** Display hint — sanitised before showing. */
  deviceName?: string;
  /** Coarse classification. */
  deviceType?: string;
};

export function parsePairingQrPayload(raw: string): PairingTarget {
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Pairing payload is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Pairing payload must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Unsupported pairing payload version ${String(obj.version)}`);
  }
  if (typeof obj.recipientPubkey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(obj.recipientPubkey)) {
    throw new Error("Pairing payload `recipientPubkey` must be a 43-char base64url string");
  }
  if (typeof obj.pairingToken !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(obj.pairingToken)) {
    throw new Error("Pairing payload `pairingToken` must be a 22-char base64url string");
  }
  const pubkeyBytes = base64UrlToBytes(obj.recipientPubkey);
  if (pubkeyBytes.length !== 32) {
    throw new Error("Pairing payload `recipientPubkey` did not decode to 32 bytes");
  }
  const deviceName =
    typeof obj.deviceName === "string" ? obj.deviceName.slice(0, 64) : "New device";
  const deviceType = typeof obj.deviceType === "string" ? obj.deviceType.slice(0, 32) : "unknown";
  return {
    recipientPubkey: pubkeyBytes,
    pairingToken: obj.pairingToken,
    suggestedDeviceName: deviceName,
    suggestedDeviceType: deviceType,
  };
}

/**
 * Helper used by the new-device side (slice in mobile / browser ext).
 * Lives here so the wire shape stays in one place.
 */
export function buildPairingQrPayload(input: Omit<PairingQrPayload, "version">): string {
  return JSON.stringify({ version: 1, ...input });
}
