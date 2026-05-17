import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "@defer/core/relay-protocol";

import type { Env } from "../src/env.js";

// Issue #28 acceptance: POST /v1/pairing and GET /v1/pairing/:token, both
// unauthenticated, KV-backed with a 60s TTL. ADR-0003 §"pairing handshake"
// covers the cryptographic shape; this file pins the wire contract.

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE = "https://relay.example.com";

// 22-char base64url pairing token (16 random bytes). Production tokens are
// CSPRNG-generated on the client; we reuse the same construction as the
// devices/events tests so each test gets a unique token.
function freshPairingToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A canonical small base64-encoded sealed payload. The real wire shape is a
// libsodium sealed `(vaultKey, deviceAuthToken)` — opaque to the relay.
function smallSealedPayload(): string {
  // `btoa("hello-pairing")` — well below the 4 KB cap.
  return btoa("hello-pairing");
}

function postPairing(body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/pairing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function getPairing(token: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/pairing/${token}`, {
    method: "GET",
    headers: extraHeaders,
  });
}

// --- POST /v1/pairing --------------------------------------------------

describe("POST /v1/pairing", () => {
  it("happy: stores the payload under the token; subsequent GET returns it", async () => {
    const token = freshPairingToken();
    const sealedPayload = smallSealedPayload();

    const put = await postPairing({ pairingToken: token, sealedPayload });
    expect(put.status).toBe(204);
    // 204 carries no body.
    expect(await put.text()).toBe("");
    // X-Request-Id is set by the middleware on every response.
    expect(put.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const get = await getPairing(token);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { sealedPayload: string };
    expect(body).toEqual({ sealedPayload });
  });

  it("malformed token (21 chars) → 422 SCHEMA_VIOLATION", async () => {
    const r = await postPairing({
      pairingToken: "A".repeat(21),
      sealedPayload: smallSealedPayload(),
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("malformed payload (non-base64 chars) → 422 SCHEMA_VIOLATION", async () => {
    const r = await postPairing({
      pairingToken: freshPairingToken(),
      sealedPayload: "not~base64!",
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("payload too large (> 4 KB decoded) → 422 SCHEMA_VIOLATION", async () => {
    // 5000 bytes of zero → base64 is ~6668 chars. Decoded length 5000 > 4096.
    const oversize = btoa("A".repeat(5000));
    const r = await postPairing({
      pairingToken: freshPairingToken(),
      sealedPayload: oversize,
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("empty payload → 422 SCHEMA_VIOLATION", async () => {
    // The regex requires at least one base64 char; an empty string fails the
    // Zod parse before reaching the size cap.
    const r = await postPairing({
      pairingToken: freshPairingToken(),
      sealedPayload: "",
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("malformed JSON body → 422 SCHEMA_VIOLATION", async () => {
    const r = await SELF.fetch(`${BASE}/v1/pairing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("idempotent re-POST same token+payload → 204 again, GET still succeeds", async () => {
    // Re-PUTs overwrite the KV entry and reset the TTL. The spec doesn't
    // require 409 here, and the pairing token is one-shot in practice, so
    // we treat overwrite as a no-op.
    const token = freshPairingToken();
    const sealedPayload = smallSealedPayload();

    const r1 = await postPairing({ pairingToken: token, sealedPayload });
    expect(r1.status).toBe(204);

    const r2 = await postPairing({ pairingToken: token, sealedPayload });
    expect(r2.status).toBe(204);

    const get = await getPairing(token);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { sealedPayload: string };
    expect(body.sealedPayload).toBe(sealedPayload);
  });

  it("idempotent re-POST same token + DIFFERENT payload → 204 and GET returns the latest", async () => {
    // Overwrite semantics: a second PUT replaces the value. Documented at
    // `pairing-token-store.ts`; this test pins the behaviour.
    const token = freshPairingToken();
    const payloadA = btoa("payload-A");
    const payloadB = btoa("payload-B-different");

    const r1 = await postPairing({ pairingToken: token, sealedPayload: payloadA });
    expect(r1.status).toBe(204);

    const r2 = await postPairing({ pairingToken: token, sealedPayload: payloadB });
    expect(r2.status).toBe(204);

    const get = await getPairing(token);
    expect(get.status).toBe(200);
    const body = (await get.json()) as { sealedPayload: string };
    expect(body.sealedPayload).toBe(payloadB);
  });

  it("ignores Authorization: Bearer ... — bogus bearer still yields 204", async () => {
    // The pairing endpoints are UNAUTH; the relay must not even look at the
    // header. Any non-empty value is acceptable here as long as the response
    // shape matches the auth-free case.
    const token = freshPairingToken();
    const sealedPayload = smallSealedPayload();
    const r = await postPairing(
      { pairingToken: token, sealedPayload },
      { Authorization: "Bearer not-a-real-token" },
    );
    expect(r.status).toBe(204);

    const get = await getPairing(token);
    expect(get.status).toBe(200);
  });

  it("preflight OPTIONS /v1/pairing returns CORS headers", async () => {
    const r = await SELF.fetch(`${BASE}/v1/pairing`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abcdef" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(r.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, X-Request-Id",
    );
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://abcdef");
  });
});

// --- GET /v1/pairing/:token --------------------------------------------

describe("GET /v1/pairing/:token", () => {
  it("happy: PUT then GET within window → 200 with sealedPayload", async () => {
    const token = freshPairingToken();
    const sealedPayload = smallSealedPayload();
    const put = await postPairing({ pairingToken: token, sealedPayload });
    expect(put.status).toBe(204);

    const get = await getPairing(token);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toContain("application/json");
    const body = (await get.json()) as { sealedPayload: string };
    expect(body).toEqual({ sealedPayload });
  });

  it("unknown token → 404 UNKNOWN_PAIRING_TOKEN", async () => {
    const r = await getPairing(freshPairingToken());
    expect(r.status).toBe(404);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("UNKNOWN_PAIRING_TOKEN");
    expect(env_.error).toBe("not_found");
  });

  it("malformed token in path (21 chars) → 422 SCHEMA_VIOLATION", async () => {
    const r = await getPairing("A".repeat(21));
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("malformed token in path (invalid charset) → 422 SCHEMA_VIOLATION", async () => {
    // `+` is standard-base64, not base64url — the regex rejects it.
    const r = await getPairing("AAAAAAAAAAAAAAAAAAAA++");
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("repeatable: GET twice in a row within the window, both 200, token NOT consumed", async () => {
    // PRD §"Pairing handshake": "polls for ≤60s". KV TTL is the only
    // retention bound; reads do NOT delete.
    const token = freshPairingToken();
    const sealedPayload = smallSealedPayload();
    await postPairing({ pairingToken: token, sealedPayload });

    const r1 = await getPairing(token);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { sealedPayload: string };
    expect(b1.sealedPayload).toBe(sealedPayload);

    const r2 = await getPairing(token);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { sealedPayload: string };
    expect(b2.sealedPayload).toBe(sealedPayload);
  });

  it("ignores Authorization: Bearer ... — bogus bearer still yields the payload", async () => {
    const token = freshPairingToken();
    const sealedPayload = smallSealedPayload();
    await postPairing({ pairingToken: token, sealedPayload });

    const r = await getPairing(token, { Authorization: "Bearer not-a-real-token" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sealedPayload: string };
    expect(body.sealedPayload).toBe(sealedPayload);
  });

  it("preflight OPTIONS /v1/pairing/:token returns CORS headers", async () => {
    const r = await SELF.fetch(`${BASE}/v1/pairing/${freshPairingToken()}`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abcdef" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(r.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, X-Request-Id",
    );
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("chrome-extension://abcdef");
  });
});

// --- TTL behaviour ------------------------------------------------------

describe("TTL behaviour", () => {
  it("PairingTokenStore.put passes expirationTtl: 60 to the KV binding", async () => {
    // Test approach: `@cloudflare/vitest-pool-workers` runs against
    // Miniflare's KV implementation, which is best-effort about TTL in
    // unit tests — wall-clock advance is the only way to expire entries
    // and `SELF.fetch` doesn't expose a time-shift hook. Rather than
    // sleep 61+ seconds in the test (slow + flaky), we verify the
    // contract the relay actually controls: every put goes through the
    // KV binding with `expirationTtl: 60`. Production KV enforces the
    // TTL server-side; the relay's role is to pass the option through.
    //
    // We spy by wrapping a real `KVNamespace` and forwarding to
    // `env.PAIRING_TOKENS.put` while recording the options. This is the
    // same pattern the issue's blocker-clause permits ("...assert only
    // that the option is passed through (spy on `kv.put` with a wrapper)").
    const { PairingTokenStore } = await import("../src/pairing-token-store.js");
    type PutOpts = { expirationTtl?: number };
    type Call = { token: string; value: string; opts: PutOpts | undefined };
    const calls: Call[] = [];
    const realKv = env.PAIRING_TOKENS;
    const spyKv = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      put: (token: string, value: string, opts?: PutOpts) => {
        calls.push({ token, value, opts });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realKv as any).put(token, value, opts);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get: (token: string, type?: string) => (realKv as any).get(token, type),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const store = new PairingTokenStore(spyKv);
    const token = freshPairingToken();
    const payload = smallSealedPayload();
    await store.put(token, payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe(token);
    expect(calls[0]?.value).toBe(payload);
    expect(calls[0]?.opts?.expirationTtl).toBe(60);
  });
});

// --- Concurrency / sanity ----------------------------------------------

describe("concurrency sanity", () => {
  it("POST + GET in Promise.all order both resolve to expected results", async () => {
    // The Workers test pool serialises within a single Worker isolate, so
    // there's no real race here — but the property the test asserts is "no
    // partial response, no 5xx". A separate test exists for the
    // happy-path ordering; this one just guards against accidental
    // regressions in handler isolation.
    const token = freshPairingToken();
    const sealedPayload = smallSealedPayload();

    // Sequence the PUT before the parallel pair so the GET has something
    // to find. (A simultaneous PUT+GET would be racy at the protocol level
    // — the spec doesn't define which wins.)
    await postPairing({ pairingToken: token, sealedPayload });

    const [a, b] = await Promise.all([getPairing(token), getPairing(token)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aBody = (await a.json()) as { sealedPayload: string };
    const bBody = (await b.json()) as { sealedPayload: string };
    expect(aBody.sealedPayload).toBe(sealedPayload);
    expect(bBody.sealedPayload).toBe(sealedPayload);
  });
});
