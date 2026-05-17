import { RelayError } from "./errors.js";

// Bearer-token parsing. Lives here (not inline at each call site) so the
// DO's `fetch()` switch can call `requireBearerToken(request)` for both
// endpoints with identical behaviour. ADR-0007 §2: missing or malformed
// `Authorization: Bearer` → 401 `INVALID_TOKEN`.
//
// The relay treats the token as opaque (a base64url string from the
// client's perspective; the relay does not parse it cryptographically).
// All cryptographic meaning lives at the client boundary (ADR-0001).

const BEARER_PREFIX = "Bearer ";

/**
 * Extracts the bearer token from an `Authorization` header. Throws
 * `RelayError("INVALID_TOKEN")` if the header is missing, malformed, or
 * the token portion is empty. Returns the raw token string (opaque to
 * the relay).
 *
 * The DO-level catch in `vault-relay.ts` normalizes the thrown error to
 * the canonical envelope (ADR-0007 §2) before returning the Response.
 */
export function requireBearerToken(request: Request): string {
  const header = request.headers.get("Authorization");
  if (header === null) {
    throw new RelayError("INVALID_TOKEN", "missing Authorization header");
  }
  if (!header.startsWith(BEARER_PREFIX)) {
    throw new RelayError("INVALID_TOKEN", "Authorization header must use the Bearer scheme");
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    throw new RelayError("INVALID_TOKEN", "empty bearer token");
  }
  return token;
}
