import { SELF } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorEnvelopeSchema } from "@defer/core/relay-protocol";

import { RelayError } from "../src/errors.js";
import { cors } from "../src/middleware/cors.js";
import { errorEnvelope } from "../src/middleware/error-envelope.js";
import { requestId } from "../src/middleware/request-id.js";

// The error envelope is the single source of truth for "how do clients learn
// what went wrong" (ADR-0007 §2). Issue #25 acceptance criteria call out
// coverage for 401, 404, 422, 500. Two of those (404 against a vault path
// and 404 catch-all) we exercise against the real Worker via `SELF`; the
// other three we exercise against a tiny in-test Hono app that uses the
// real middleware modules — same code, different routes. This keeps the
// scaffold from having to expose a test-only "throw me a 500" endpoint.

function makeTestApp(): Hono {
  const app = new Hono();
  app.use("*", cors({}), requestId());
  app.onError(errorEnvelope());

  app.get("/401", () => {
    throw new RelayError("INVALID_TOKEN");
  });
  app.get("/422", () => {
    z.object({ requiredField: z.string() }).parse({}); // ZodError
    return new Response("unreachable");
  });
  app.get("/500", () => {
    throw new Error("unexpected boom");
  });
  return app;
}

describe("error envelope (ADR-0007 §2) — 404 against the real Worker", () => {
  it("404 UNKNOWN_VAULT — /v1/vault/:vaultId returns the canonical envelope", async () => {
    const response = await SELF.fetch(
      "https://relay.example.com/v1/vault/abcdef0123456789abcdef0123456789/events",
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");

    const body = await response.json();
    const parsed = ErrorEnvelopeSchema.parse(body);
    expect(parsed.code).toBe("UNKNOWN_VAULT");
    expect(parsed.error).toBe("not_found");

    expect(response.headers.get("X-Request-Id")).toBe(parsed.requestId);
  });

  it("404 for an unknown non-vault route still returns an envelope", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/no-such-route");
    expect(response.status).toBe(404);
    const body = await response.json();
    const parsed = ErrorEnvelopeSchema.parse(body);
    expect(parsed.error).toBe("not_found");
  });

  it("X-Request-Id is set on every error response", async () => {
    const response = await SELF.fetch("https://relay.example.com/v1/no-such-route");
    expect(response.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("error envelope (ADR-0007 §2) — middleware against an in-test app", () => {
  const app = makeTestApp();

  it("401 INVALID_TOKEN — RelayError maps to status + canonical envelope", async () => {
    const response = await app.request("/401");
    expect(response.status).toBe(401);
    const parsed = ErrorEnvelopeSchema.parse(await response.json());
    expect(parsed.code).toBe("INVALID_TOKEN");
    expect(parsed.error).toBe("unauthorized");
  });

  it("422 SCHEMA_VIOLATION — ZodError is caught and mapped", async () => {
    const response = await app.request("/422");
    expect(response.status).toBe(422);
    const parsed = ErrorEnvelopeSchema.parse(await response.json());
    expect(parsed.code).toBe("SCHEMA_VIOLATION");
    expect(parsed.error).toBe("invalid_request");
  });

  it("500 INTERNAL_ERROR — unexpected throws become generic envelopes", async () => {
    const response = await app.request("/500");
    expect(response.status).toBe(500);
    const parsed = ErrorEnvelopeSchema.parse(await response.json());
    expect(parsed.code).toBe("INTERNAL_ERROR");
    expect(parsed.error).toBe("internal_error");
  });

  it("Content-Type is application/json on every error", async () => {
    for (const path of ["/401", "/422", "/500"]) {
      const response = await app.request(path);
      expect(response.headers.get("Content-Type")).toContain("application/json");
    }
  });
});
