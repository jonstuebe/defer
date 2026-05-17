import { describe, expect, it } from "vitest";

import { bytesToBase64Url, base64UrlToBytes, randomClientNonceBase64Url } from "./base64.js";

describe("base64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    const decoded = base64UrlToBytes(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("randomClientNonceBase64Url returns 22 chars matching the wire regex", () => {
    for (let i = 0; i < 25; i += 1) {
      const nonce = randomClientNonceBase64Url();
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });
});
