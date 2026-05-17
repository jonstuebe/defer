import { ERROR_CODES, type ErrorCode } from "@defer/core/relay-protocol";

// Mapping from the closed-enum `code` to the human-readable `error` category
// pinned by ADR-0007 §2. Kept here (and not in @defer/core) because client
// code never needs to compute the category from a `code` — clients pattern
// match on `code`. The relay derives the category at response-time.
const ERROR_CATEGORY_FOR_CODE: Record<ErrorCode, string> = {
  INVALID_TOKEN: "unauthorized",
  EXPIRED_PAIRING_TOKEN: "not_found",
  WRONG_VAULT_FOR_TOKEN: "forbidden",
  UNKNOWN_VAULT: "not_found",
  UNKNOWN_DEVICE: "not_found",
  UNKNOWN_PAIRING_TOKEN: "not_found",
  DELETION_ALREADY_SCHEDULED: "conflict",
  DUPLICATE_CLIENT_NONCE: "conflict",
  DEVICE_ALREADY_REGISTERED: "conflict",
  VAULT_DELETED: "gone",
  SCHEMA_VIOLATION: "invalid_request",
  RATE_LIMITED: "rate_limited",
  INTERNAL_ERROR: "internal_error",
};

export function categoryForCode(code: ErrorCode): string {
  return ERROR_CATEGORY_FOR_CODE[code];
}

export function statusForCode(code: ErrorCode): number {
  return ERROR_CODES[code];
}

/**
 * Typed error thrown by handlers. The error envelope middleware (ADR-0007 §2)
 * catches these and maps them to the canonical JSON shape + status code.
 *
 * Handlers should NOT construct `Response` objects for error cases — throw a
 * `RelayError` so the middleware can attach `requestId` and the consistent
 * shape uniformly. The only place that builds error `Response`s directly is
 * the middleware itself.
 */
export class RelayError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly category: string;
  readonly headers: Record<string, string>;
  // ADR-0007 §2 optional context object. Today only DUPLICATE_CLIENT_NONCE
  // populates this (`{ eventIndex }`); future endpoints may carry whatever
  // shape is useful. The error-envelope middleware copies this verbatim into
  // the response body.
  details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, headers: Record<string, string> = {}) {
    super(message ?? code);
    this.name = "RelayError";
    this.code = code;
    this.status = statusForCode(code);
    this.category = categoryForCode(code);
    this.headers = headers;
  }

  // Fluent setter so the call-site reads `throw new RelayError(...).withDetails(...)`
  // without having to mutate-then-throw. Returns `this` so it composes inline.
  withDetails(details: Record<string, unknown>): this {
    this.details = details;
    return this;
  }
}

// Sugar constructors. Use the most specific one available — generic
// `new RelayError("INTERNAL_ERROR")` should be rare and exists for the
// catch-all branch in the error-envelope middleware.
export const unauthorized = (msg?: string): RelayError => new RelayError("INVALID_TOKEN", msg);
export const unknownVault = (msg?: string): RelayError => new RelayError("UNKNOWN_VAULT", msg);
export const unknownDevice = (msg?: string): RelayError => new RelayError("UNKNOWN_DEVICE", msg);
export const unknownPairingToken = (msg?: string): RelayError =>
  new RelayError("UNKNOWN_PAIRING_TOKEN", msg);
export const schemaViolation = (msg?: string): RelayError =>
  new RelayError("SCHEMA_VIOLATION", msg);
export const vaultDeleted = (msg?: string): RelayError => new RelayError("VAULT_DELETED", msg);
export const internalError = (msg?: string): RelayError => new RelayError("INTERNAL_ERROR", msg);
