import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /v1/health", () => {
  it("returns 200 with { ok, version }", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });

  it("emits an X-Request-Id header that is a valid UUID v7", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health");
    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).not.toBeNull();
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("echoes an incoming valid X-Request-Id header (cross-tier tracing)", async () => {
    const incoming = "01919b50-7000-7abc-8def-0123456789ab";
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      headers: { "X-Request-Id": incoming },
    });
    expect(response.headers.get("X-Request-Id")).toBe(incoming);
  });

  it("generates a fresh X-Request-Id when the incoming one is not a valid v7", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      headers: { "X-Request-Id": "not-a-uuid" },
    });
    const out = response.headers.get("X-Request-Id");
    expect(out).not.toBe("not-a-uuid");
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
