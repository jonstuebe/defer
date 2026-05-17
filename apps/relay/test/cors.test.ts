import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// CORS policy: ADR-0007 §3.
//   - Methods: GET, POST, DELETE, OPTIONS
//   - Headers: Authorization, Content-Type, X-Request-Id
//   - No Allow-Credentials
//   - Max-Age: 600
//   - Allow-Origin echoed only for allowlist matches
//
// Default allowlist (compiled in): chrome-extension://*, safari-web-extension://*,
// tauri://*. Extended via the CORS_ALLOWED_ORIGINS env var (empty in tests).

describe("CORS preflight (OPTIONS /v1/health)", () => {
  it("returns 204 with the canonical method/header advertisement", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abcdef" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, X-Request-Id",
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe("600");
  });

  it("never emits Access-Control-Allow-Credentials", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abcdef" },
    });
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("echoes Origin when it matches the chrome-extension default", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abcdef" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://abcdef");
  });

  it("echoes Origin for safari-web-extension://*", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      method: "OPTIONS",
      headers: { Origin: "safari-web-extension://0123" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("safari-web-extension://0123");
  });

  it("echoes Origin for tauri://*", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      method: "OPTIONS",
      headers: { Origin: "tauri://localhost" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");
  });

  it("omits Access-Control-Allow-Origin for a non-allowlisted origin", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("CORS on a real GET request (cross-origin GET)", () => {
  it("succeeds and echoes Origin when allowed", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      headers: { Origin: "chrome-extension://abcdef" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://abcdef");
    // Sanity: the response is still the canonical health body.
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("succeeds but omits Allow-Origin for a non-allowlisted origin", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/health", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
