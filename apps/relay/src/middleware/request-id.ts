import type { MiddlewareHandler } from "hono";

// UUID v7 layout per RFC 9562 §5.7. 48-bit Unix-millis timestamp, 4-bit
// version (0b0111), 12 random bits, 2-bit variant (0b10), 62 random bits.
// We write 16 bytes via crypto.getRandomValues, then patch the timestamp /
// version / variant fields. Output is canonical 8-4-4-4-12 hex.

const UUID_V7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function generateUuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian timestamp at bytes [0..6).
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Version = 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Variant = 0b10 in the high two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  }
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function isValidUuidV7(s: string): boolean {
  return UUID_V7_REGEX.test(s);
}

/**
 * Honours an incoming `X-Request-Id` only if it parses as a valid UUID v7
 * (cross-tier tracing). Otherwise generates a fresh one. The middleware
 * attaches the id to the context under `requestId` and echoes it on the
 * response. The error-envelope middleware reads `c.get("requestId")` when
 * constructing the envelope JSON.
 */
export const requestId = (): MiddlewareHandler => async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming !== undefined && isValidUuidV7(incoming) ? incoming : generateUuidV7();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
};
