import { z } from "zod";

// Relay-protocol error envelope and `code` enum.
//
// Every non-2xx response from any relay endpoint MUST carry this JSON shape:
//
//   { "error": "unauthorized", "code": "INVALID_TOKEN", "requestId": "..." }
//
// `code` is a closed enum — adding a new code is a protocol bump. Clients
// pattern-match against `code`, not against `error`, and a relay shipping a
// new `code` without a protocol bump trips the client's schema check at the
// boundary. See ADR-0007 §2 for the rationale, the canonical status-code
// table, and the full vocabulary.
//
// Forward-compat note: adding new codes is forbidden without a protocol bump.
// Removing or repurposing codes is forbidden — clients pin against this enum.

/**
 * Closed enum of machine-readable error codes returned in the relay's error
 * envelope. Each code has exactly one canonical HTTP status, with one
 * documented exception: `EXPIRED_PAIRING_TOKEN` may legitimately surface as
 * either 404 or 410 (ADR-0007 §2). The default implementation always returns
 * 404 / `UNKNOWN_PAIRING_TOKEN` for expired-or-unknown pairing tokens; the
 * 410 row is reserved for forward-compat.
 */
export const ERROR_CODES = {
  INVALID_TOKEN: 401,
  EXPIRED_PAIRING_TOKEN: 404,
  WRONG_VAULT_FOR_TOKEN: 403,
  UNKNOWN_VAULT: 404,
  UNKNOWN_DEVICE: 404,
  UNKNOWN_PAIRING_TOKEN: 404,
  DELETION_ALREADY_SCHEDULED: 409,
  DUPLICATE_CLIENT_NONCE: 409,
  VAULT_DELETED: 410,
  SCHEMA_VIOLATION: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_CODES;
export type ErrorStatus = (typeof ERROR_CODES)[ErrorCode];

/**
 * Human-readable short category, mirrors HTTP status semantics. Picked for
 * triage at a glance; clients SHOULD NOT pattern-match against `error` — they
 * MUST pattern-match against `code` (which is the closed enum).
 */
export const ERROR_CATEGORIES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "gone",
  "invalid_request",
  "rate_limited",
  "internal_error",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const ERROR_CODE_VALUES = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

/**
 * Zod schema for the relay's error envelope. Parses real relay responses and
 * rejects unknown `code` values — a relay shipping a new `code` without a
 * protocol bump trips this schema at the client boundary.
 *
 * `requestId` is a UUID v7 generated per request and echoed in the
 * `X-Request-Id` response header. Validated specifically as v7 so a relay
 * that accidentally emits a v4 UUID (which would sort poorly in log scans)
 * trips the schema at the client boundary.
 *
 * `details` is an optional, free-form object carrying code-specific context
 * (e.g. `{ eventIndex: 3 }` for `DUPLICATE_CLIENT_NONCE` to point at the
 * offending event in a batch). The shape varies per code; clients SHOULD
 * treat unknown fields as informational only. Added in ADR-0007 §2 (not a
 * breaking change — the envelope is parsed non-strict and pre-existing
 * producers continue to validate).
 */
export const ErrorEnvelopeSchema = z.object({
  error: z.enum(ERROR_CATEGORIES),
  code: z.enum(ERROR_CODE_VALUES),
  requestId: z.uuidv7(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
