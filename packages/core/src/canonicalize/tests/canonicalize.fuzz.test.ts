import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../index.js";

describe("canonicalize — fuzz", () => {
  it("never throws on fast-check webUrl inputs", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        canonicalize(url);
      }),
      { numRuns: 500 },
    );
  });

  it("is idempotent for fast-check webUrl inputs", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const once = canonicalize(url);
        const twice = canonicalize(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("never reintroduces a stripped tracking param via re-canonicalization", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const once = canonicalize(url);
        expect(once).not.toMatch(/[?&]utm_/i);
        expect(once).not.toMatch(/[?&]fbclid=/i);
        expect(once).not.toMatch(/[?&]gclid=/i);
      }),
      { numRuns: 500 },
    );
  });
});
