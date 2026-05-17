import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashVaultId } from "../src/log/hash-vault-id.js";

// The blind-relay invariant (ADR-0001) demands that vault IDs never appear in
// raw form in logs. The logging middleware emits one JSON log line per
// request; when the path matches `/v1/vault/:vaultId/...`, the vaultId is
// HMAC-hashed under the relay-local LOG_HMAC_SECRET and truncated to 16 hex
// chars. We assert that:
//   1. the raw vaultId never appears in the emitted log line, AND
//   2. the hashed value DOES appear (so operators can correlate by vault
//      without learning the vault's identity).
//
// `LOG_HMAC_SECRET` in `vitest.config.ts` is `"dev-secret-for-tests"`; we
// pre-compute the expected hash via the same `hashVaultId` helper the
// middleware uses.

// 22-char base64url — matches the router-boundary VAULT_ID_REGEX. The
// specific bytes don't matter for this test (we only assert the hash); we
// just need a wire-shaped value so the route validation lets the request
// through to the logging middleware.
const RAW_VAULT_ID = "abcdefghijklmnopqrstuv";
const LOG_HMAC_SECRET = "dev-secret-for-tests";

interface ParsedLogLine {
  ts: string;
  requestId: string | null;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  vaultIdHash: string | null;
}

function findVaultLogLine(spy: ReturnType<typeof vi.spyOn>): ParsedLogLine | null {
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg !== "string" || !arg.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(arg) as Partial<ParsedLogLine>;
      if (typeof parsed.path === "string" && parsed.path.includes("/v1/vault/")) {
        return parsed as ParsedLogLine;
      }
    } catch {
      // not a JSON log line — skip
    }
  }
  return null;
}

describe("structured logging — blind-relay invariant", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a JSON log line per request with the canonical shape", async () => {
    await SELF.fetch("https://relay.example.com/v1/health");
    // At least one console.log call with a parseable JSON object.
    const jsonLines = logSpy.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === "string" && arg.startsWith("{"));
    expect(jsonLines.length).toBeGreaterThan(0);

    const parsed = JSON.parse(jsonLines[0]!) as ParsedLogLine;
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/v1/health");
    expect(parsed.status).toBe(200);
    expect(typeof parsed.latencyMs).toBe("number");
    expect(parsed.vaultIdHash).toBeNull();
  });

  it("hashes the vaultId on a /v1/vault/:vaultId/ path and never logs it raw", async () => {
    await SELF.fetch(`https://relay.example.com/v1/vault/${RAW_VAULT_ID}/events`);

    const logLine = findVaultLogLine(logSpy);
    expect(logLine).not.toBeNull();
    expect(logLine!.vaultIdHash).not.toBeNull();
    expect(logLine!.vaultIdHash!.length).toBe(16);

    // The hash matches what the production hashVaultId helper computes.
    const expected = await hashVaultId(RAW_VAULT_ID, LOG_HMAC_SECRET);
    expect(logLine!.vaultIdHash).toBe(expected);

    // The raw vaultId never appears in ANY emitted log line.
    for (const call of logSpy.mock.calls) {
      const arg = call[0];
      if (typeof arg !== "string") continue;
      expect(arg.includes(RAW_VAULT_ID)).toBe(false);
    }
  });
});
