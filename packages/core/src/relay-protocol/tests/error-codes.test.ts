import { describe, expect, it } from "vitest";

import { ERROR_CODES, ERROR_CATEGORIES, ErrorEnvelopeSchema, type ErrorCode } from "../index.js";

// A real UUID v7 fixture (verified against the RFC 9562 layout: the version
// nibble in the 13th hex char is "7"). Used so the envelope-shape tests can
// exercise the actual `uuidv7()` schema without depending on a generator.
const REQUEST_ID_V7 = "018f6c8f-7e3a-7000-8000-abcdef012345";

describe("ERROR_CODES", () => {
  it("is a closed enum of code -> canonical HTTP status pairs", () => {
    // If this list ever changes, ADR-0007 §2 needs to change in lockstep.
    // The test is intentionally redundant with the source — it's the
    // closed-enum contract written twice so renames or accidental additions
    // fail loudly.
    const expected = {
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
    } as const;
    expect(ERROR_CODES).toEqual(expected);
  });

  it("each code maps to a status in the v1 status table", () => {
    const allowedStatuses = new Set([401, 403, 404, 409, 410, 422, 429, 500]);
    for (const status of Object.values(ERROR_CODES)) {
      expect(allowedStatuses.has(status)).toBe(true);
    }
  });
});

describe("ERROR_CATEGORIES", () => {
  it("matches the v1 vocabulary", () => {
    expect(new Set(ERROR_CATEGORIES)).toEqual(
      new Set([
        "unauthorized",
        "forbidden",
        "not_found",
        "conflict",
        "gone",
        "invalid_request",
        "rate_limited",
        "internal_error",
      ]),
    );
  });
});

describe("ErrorEnvelopeSchema", () => {
  it("parses a real example", () => {
    const envelope = {
      error: "unauthorized" as const,
      code: "INVALID_TOKEN" as const,
      requestId: REQUEST_ID_V7,
    };
    const parsed = ErrorEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
  });

  it("parses every code in the enum", () => {
    // Pick a sane category per code so the envelope is internally coherent.
    // We don't enforce category<->code coupling at the schema level (the relay
    // controls both, and decoupling keeps category as triage-only).
    for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
      const result = ErrorEnvelopeSchema.safeParse({
        error: "internal_error" as const,
        code,
        requestId: REQUEST_ID_V7,
      });
      expect(result.success, `code=${code} should parse`).toBe(true);
    }
  });

  it("rejects unknown `code` values", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: "internal_error",
      code: "TEAPOT",
      requestId: REQUEST_ID_V7,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown `error` categories", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: "kaboom",
      code: "INTERNAL_ERROR",
      requestId: REQUEST_ID_V7,
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed `requestId`", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: "internal_error",
      code: "INTERNAL_ERROR",
      requestId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-v7 UUID for `requestId`", () => {
    // A valid UUID v4 (version nibble "4") — should fail because we pin v7
    // specifically so log-scan ordering is preserved.
    const v4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const result = ErrorEnvelopeSchema.safeParse({
      error: "internal_error",
      code: "INTERNAL_ERROR",
      requestId: v4,
    });
    expect(result.success).toBe(false);
  });
});
