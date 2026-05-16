import { describe, expect, it } from "vitest";
import { canonicalize } from "../index.js";

const cases: ReadonlyArray<readonly [string, string, string]> = [
  ["utm_source stripped", "https://example.com/x?utm_source=newsletter", "https://example.com/x"],
  ["utm_medium stripped", "https://example.com/x?utm_medium=email", "https://example.com/x"],
  ["utm_campaign stripped", "https://example.com/x?utm_campaign=spring", "https://example.com/x"],
  ["utm_term stripped", "https://example.com/x?utm_term=running+shoes", "https://example.com/x"],
  ["utm_content stripped", "https://example.com/x?utm_content=cta_top", "https://example.com/x"],
  [
    "arbitrary utm_ prefix stripped",
    "https://example.com/x?utm_brand=nike",
    "https://example.com/x",
  ],
  ["fbclid stripped", "https://example.com/x?fbclid=abc123", "https://example.com/x"],
  ["gclid stripped", "https://example.com/x?gclid=abc123", "https://example.com/x"],
  ["mc_cid stripped", "https://example.com/x?mc_cid=abc", "https://example.com/x"],
  ["mc_eid stripped", "https://example.com/x?mc_eid=abc", "https://example.com/x"],
  ["ref stripped", "https://example.com/x?ref=twitter", "https://example.com/x"],
  ["ref_src stripped", "https://example.com/x?ref_src=twsrc", "https://example.com/x"],
  ["igshid stripped", "https://example.com/x?igshid=abc", "https://example.com/x"],
  ["_ga stripped", "https://example.com/x?_ga=GA1.2.3", "https://example.com/x"],
  ["yclid stripped", "https://example.com/x?yclid=abc", "https://example.com/x"],

  ["hostname lowercased", "HTTPS://EXAMPLE.COM/", "https://example.com/"],
  ["mixed-case hostname lowercased", "https://EXAMPLE.com/foo", "https://example.com/foo"],

  ["default https port stripped", "https://example.com:443/x", "https://example.com/x"],
  ["default http port stripped", "http://example.com:80/x", "http://example.com/x"],
  ["non-default port retained", "https://example.com:8080/x", "https://example.com:8080/x"],
  ["non-default http port retained", "http://example.com:8081/x", "http://example.com:8081/x"],

  ["trailing slash stripped", "https://example.com/foo/", "https://example.com/foo"],
  ["nested trailing slash stripped", "https://example.com/foo/bar/", "https://example.com/foo/bar"],
  ["root path preserved", "https://example.com/", "https://example.com/"],
  ["bare host gets root path", "https://example.com", "https://example.com/"],

  ["fragment stripped", "https://example.com/x#section", "https://example.com/x"],
  ["fragment with content stripped", "https://example.com/x?q=1#frag", "https://example.com/x?q=1"],

  [
    "non-tracking query params preserved",
    "https://example.com/search?q=hello",
    "https://example.com/search?q=hello",
  ],
  [
    "non-tracking query param order preserved",
    "https://example.com/x?b=2&a=1&c=3",
    "https://example.com/x?b=2&a=1&c=3",
  ],
  [
    "tracking removed but non-tracking order preserved",
    "https://example.com/x?b=2&utm_source=x&a=1",
    "https://example.com/x?b=2&a=1",
  ],

  [
    "mixed kitchen sink",
    "https://EXAMPLE.com:443/foo/?utm_source=x&q=hello#section",
    "https://example.com/foo?q=hello",
  ],
];

describe("canonicalize", () => {
  for (const [label, input, expected] of cases) {
    it(label, () => {
      expect(canonicalize(input)).toBe(expected);
    });
  }

  it("idempotence — applying twice yields the same result for every table case", () => {
    for (const [, input] of cases) {
      const once = canonicalize(input);
      const twice = canonicalize(once);
      expect(twice).toBe(once);
    }
  });

  it("IDN/punycode produces a stable canonical form", () => {
    const once = canonicalize("https://例え.jp/");
    const twice = canonicalize(once);
    expect(twice).toBe(once);
    expect(once).toMatch(/^https:\/\/xn--/);
  });

  it("preserves explicit port equal to non-default scheme port", () => {
    expect(canonicalize("https://example.com:8443/")).toBe("https://example.com:8443/");
  });

  it("drops trailing '?' when all params were tracking", () => {
    expect(canonicalize("https://example.com/x?utm_source=x&fbclid=y")).toBe(
      "https://example.com/x",
    );
  });
});
