import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, isTrackingParam } from "../index.js";

const trackedWebUrl = fc
  .tuple(
    fc.webUrl(),
    fc.array(
      fc.tuple(
        fc.constantFrom(
          "utm_source",
          "utm_medium",
          "utm_campaign",
          "utm_brand",
          "fbclid",
          "gclid",
          "mc_cid",
          "ref",
          "_ga",
          "q",
          "page",
        ),
        fc.string(),
      ),
      { minLength: 0, maxLength: 6 },
    ),
  )
  .map(([base, params]) => {
    const u = new URL(base);
    for (const [k, v] of params) u.searchParams.append(k, v);
    return u.toString();
  });

describe("canonicalize — fuzz", () => {
  it("never throws on fast-check webUrl inputs", () => {
    fc.assert(
      fc.property(trackedWebUrl, (url) => {
        canonicalize(url);
      }),
      { numRuns: 500 },
    );
  });

  it("is idempotent for fast-check webUrl inputs", () => {
    fc.assert(
      fc.property(trackedWebUrl, (url) => {
        const once = canonicalize(url);
        const twice = canonicalize(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("output contains no tracking params (inspected via parsed URL)", () => {
    fc.assert(
      fc.property(trackedWebUrl, (url) => {
        const once = canonicalize(url);
        const parsed = new URL(once);
        for (const key of parsed.searchParams.keys()) {
          expect(isTrackingParam(key)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("output never contains userinfo, fragment, or default port", () => {
    fc.assert(
      fc.property(trackedWebUrl, (url) => {
        const parsed = new URL(canonicalize(url));
        expect(parsed.username).toBe("");
        expect(parsed.password).toBe("");
        expect(parsed.hash).toBe("");
        if (parsed.protocol === "https:") expect(parsed.port).not.toBe("443");
        if (parsed.protocol === "http:") expect(parsed.port).not.toBe("80");
      }),
      { numRuns: 500 },
    );
  });

  it("hostname is always lowercase", () => {
    fc.assert(
      fc.property(trackedWebUrl, (url) => {
        const parsed = new URL(canonicalize(url));
        expect(parsed.hostname).toBe(parsed.hostname.toLowerCase());
      }),
      { numRuns: 500 },
    );
  });

  it("path never has a trailing slash unless it is the root", () => {
    fc.assert(
      fc.property(trackedWebUrl, (url) => {
        const parsed = new URL(canonicalize(url));
        if (parsed.pathname.length > 1) {
          expect(parsed.pathname.endsWith("/")).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("preserves non-tracking params that were present in the input", () => {
    fc.assert(
      fc.property(trackedWebUrl, (url) => {
        const inputKeys = [...new URL(url).searchParams.keys()];
        const outputKeys = new Set(new URL(canonicalize(url)).searchParams.keys());
        for (const k of inputKeys) {
          if (!isTrackingParam(k)) {
            expect(outputKeys.has(k)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
