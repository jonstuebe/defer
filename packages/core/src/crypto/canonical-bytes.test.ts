import { describe, expect, it } from "vitest";

import { canonicalizeForSigning, envelopeForSigning } from "./canonical-bytes.js";

describe("canonicalizeForSigning", () => {
  it("produces identical bytes regardless of input key order", () => {
    const a = canonicalizeForSigning({ b: 2, a: 1 });
    const b = canonicalizeForSigning({ a: 1, b: 2 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("encodes strings + numbers + nested objects deterministically", () => {
    const out = canonicalizeForSigning({ z: { c: 3, a: "1" }, a: [1, 2] });
    expect(new TextDecoder().decode(out)).toBe('{"a":[1,2],"z":{"a":"1","c":3}}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalizeForSigning(NaN)).toThrow(/non-finite/);
    expect(() => canonicalizeForSigning(Infinity)).toThrow(/non-finite/);
  });

  it("skips undefined properties (matching JSON behaviour)", () => {
    const out = canonicalizeForSigning({ a: 1, b: undefined });
    expect(new TextDecoder().decode(out)).toBe('{"a":1}');
  });
});

describe("envelopeForSigning", () => {
  it("strips `signature` and `seq` before canonicalizing", () => {
    const a = envelopeForSigning({ type: "X", data: { foo: 1 }, signature: "sig-here", seq: 5 });
    const b = envelopeForSigning({ type: "X", data: { foo: 1 } });
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
