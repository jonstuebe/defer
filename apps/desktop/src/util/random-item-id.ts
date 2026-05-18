import { bytesToHex } from "./base64.js";

/**
 * 16-byte random item ID as 32-char hex. Item IDs are device-local in v1 —
 * the canonical URL is the dedupe key (ADR-0002, projection's "touch"
 * semantics), so collisions across devices are harmless and uniqueness is
 * only required within a single emit.
 */
export function generateItemId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}
