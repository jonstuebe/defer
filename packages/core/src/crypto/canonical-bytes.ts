/**
 * Canonical byte representation for vault-key-MAC'd events.
 *
 * Per `events/vault-events.ts` docstring (and ADR-0006), the MAC covers
 * "JCS (RFC 8785) canonicalization of the envelope JSON with the
 * `signature` field removed AND the `seq` field removed."
 *
 * Slice #59 ships a deterministic encoder that produces the same bytes
 * for any equivalent value: sorted object keys, no whitespace, JSON
 * escaping for strings, and JSON's natural integer formatting. v1 vault
 * events only ever hold integers + short ASCII strings + nested objects
 * with the same property — strict RFC 8785 number-formatting rules (e.g.
 * exponent ranges, trailing-zero stripping) don't apply here because
 * none of the signed payloads carry floats.
 *
 * As long as **the same encoder runs on both sides** (sign + verify),
 * v1 round-trips correctly. A future protocol iteration can swap this
 * for a fully RFC-8785-compliant module; the function signature is the
 * one external consumers will keep.
 */
export function canonicalizeForSigning(value: unknown): Uint8Array {
  const text = canonicalJsonString(value);
  return new TextEncoder().encode(text);
}

function canonicalJsonString(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalizeForSigning: non-finite numbers are not signable");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonString(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((key) => {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) return ""; // skipped — JSON omits undefined fields
      return `${JSON.stringify(key)}:${canonicalJsonString(v)}`;
    });
    return `{${entries.filter((s) => s !== "").join(",")}}`;
  }
  throw new TypeError(`canonicalizeForSigning: unsupported value of type ${typeof value}`);
}

/**
 * Helper for the slice-#59 / ADR-0006 contract: strip `signature` and
 * `seq` before canonicalizing. Callers who hold the full envelope and
 * want signing bytes use this to get the right input.
 */
export function envelopeForSigning(envelope: Record<string, unknown>): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _sig, seq: _seq, ...rest } = envelope;
  return canonicalizeForSigning(rest);
}
