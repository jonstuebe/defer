import type { Context } from "hono";
import { Hono } from "hono";
import {
  MAX_SEALED_PAYLOAD_BYTES,
  PAIRING_TOKEN_REGEX,
  PutPairingRequestSchema,
} from "@defer/core/relay-protocol";

import type { Env } from "./env.js";
import { cors } from "./middleware/cors.js";
import { errorEnvelope } from "./middleware/error-envelope.js";
import { logging } from "./middleware/logging.js";
import { requestId } from "./middleware/request-id.js";
import { PairingTokenStore } from "./pairing-token-store.js";
import { schemaViolation, unknownPairingToken, unknownVault } from "./errors.js";

// `vaultId` on the wire is the 22-char base64url encoding of a 16-byte HKDF
// output (ADR-0003 §"vault id derivation"). The closed regex matches the same
// alphabet/length used everywhere else for base64url 16-byte values (e.g. the
// `clientNonce` and `deviceId` envelope fields). Validating at the router
// boundary catches malformed path params before they reach the DO and ensures
// `SCHEMA_VIOLATION` is the response shape — the alternative ("treat any
// string as a DO name") would let unguessable junk bind to bogus DOs.
const VAULT_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;

function validateVaultId(raw: string): string {
  if (!VAULT_ID_REGEX.test(raw)) {
    throw schemaViolation("vaultId path param must be 22 base64url chars (16 bytes, no padding)");
  }
  return raw;
}

// Pairing tokens share the same 22-char base64url shape as vault IDs (16
// bytes encoded URL-safely, no padding). Validating at the router boundary
// keeps malformed input from ever reaching KV and produces SCHEMA_VIOLATION
// before any Zod parse on the body — see ADR-0003 §"pairing handshake" for
// the token's role and ADR-0007 §2 for the error envelope.
function validatePairingToken(raw: string): string {
  if (!PAIRING_TOKEN_REGEX.test(raw)) {
    throw schemaViolation(
      "pairingToken path param must be 22 base64url chars (16 bytes, no padding)",
    );
  }
  return raw;
}

// Decoded byte length of a standard-base64 string, no allocation. The Zod
// schema already verified the charset is `[A-Za-z0-9+/=]+`; the formula is
// the canonical "ceil to multiple of 4, subtract padding" but since the
// regex permits up to two `=` we just count.
function decodedBase64Length(s: string): number {
  const padCount = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padCount;
}

// Hono context variables surfaced by the middleware chain.
type Variables = {
  requestId: string;
};

const VERSION = "0.0.0";

// Vault IDs on the wire are the 22-char base64url encoding of a 16-byte HKDF
// output (ADR-0003 §"vault id derivation"). Shape is enforced at the router
// boundary by `validateVaultId` above — anything that doesn't match the
// closed regex never reaches this helper. The unguessable HKDF output is the
// auth signal per ADR-0007 §1; this stub-lookup trusts the caller to have
// already validated the string.
function getVaultStub(env: Env, vaultId: string) {
  const id = env.VAULT_RELAY.idFromName(vaultId);
  return env.VAULT_RELAY.get(id);
}

// Forwarding the per-vault HTTP request to the DO. The DO sees a path
// stripped of the `/v1/vault/:vaultId` prefix so it can match on `/events`
// directly. We preserve method, headers (including `Authorization`), and
// body — the DO trusts the Worker to deliver these unchanged. The response
// flows back verbatim except for error envelopes, where the DO can't know
// the per-request `requestId`; we patch the placeholder here.
async function forwardToDurableObject(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  vaultId: string,
  innerPath: string,
): Promise<Response> {
  const stub = getVaultStub(c.env, vaultId);

  // Re-issue the request against a synthetic URL the DO's switch matches on.
  // We MUST forward the original body (POST events) and `Authorization`
  // header, plus the query string so `?since=` survives.
  //
  // `innerPath` is the path the DO's dispatcher sees (e.g. `/events`,
  // `/devices`, `/devices/<deviceId>`). The Worker route strips the
  // `/v1/vault/:vaultId` prefix and rewrites to the inner path so the DO
  // doesn't have to know the public URL shape.
  //
  // Reading the body as an ArrayBuffer first (rather than streaming) buys
  // type-system compatibility with `stub.fetch`'s Cloudflare-typed Request:
  // a `Uint8Array` body satisfies the BodyInit type on both standard and
  // CF Request constructors. The cost (one extra in-memory copy of the
  // batch) is negligible at our scale — batches cap at 100 events × ~500
  // bytes each, well under any meaningful budget.
  const original = c.req.raw;
  const incomingUrl = new URL(original.url);
  const innerUrl = new URL(`https://do.invalid${innerPath}`);
  innerUrl.search = incomingUrl.search;

  const hasBody = original.method !== "GET" && original.method !== "HEAD";
  const bodyBytes = hasBody ? new Uint8Array(await original.arrayBuffer()) : null;
  // The CF Workers Types ship their own `Request`/`RequestInit` types that
  // collide with the lib-DOM ones on `exactOptionalPropertyTypes`. Passing
  // `(url, init)` to `stub.fetch` rather than a constructed `Request` skips
  // the cross-type collision; the stub treats the first arg as a `RequestInfo`
  // (URL string) and the second as its own init type. Cast through `unknown`
  // because the global `RequestInit` and CF's `RequestInit` differ in their
  // optional-property nullability, not their runtime shape.
  const init = {
    method: original.method,
    headers: original.headers,
    body: bodyBytes,
  } as unknown as RequestInit;
  const doResponse = (await stub.fetch(
    innerUrl.toString(),
    init as Parameters<typeof stub.fetch>[1],
  )) as unknown as Response;

  // 2xx — pass straight through, with the per-request id stamped so client
  // logs can correlate against the relay's request-id middleware output.
  // 4xx/5xx — patch the placeholder requestId the DO stamped in the JSON body.
  const id = c.get("requestId");
  if (doResponse.status >= 200 && doResponse.status < 300) {
    // Reading the body eagerly avoids the `ReadableStream` typing collision
    // between the lib-DOM and CF stream types — for our payloads (capped at
    // 100 events × ~500 bytes) the in-memory cost is negligible.
    const buf = await doResponse.arrayBuffer();
    const out = new Response(buf, {
      status: doResponse.status,
      headers: new Headers(doResponse.headers as unknown as HeadersInit),
    });
    out.headers.set("X-Request-Id", id);
    return out;
  }

  // Error path. The DO serialised an envelope with a sentinel requestId; we
  // parse, rewrite, and re-serialise. If the parse fails (shouldn't), the
  // outer onError middleware catches the JSON.parse throw.
  const bodyText = await doResponse.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    body = { error: "internal_error", code: "INTERNAL_ERROR" };
  }
  body.requestId = id;

  const headers = new Headers(doResponse.headers as unknown as HeadersInit);
  headers.set("Content-Type", "application/json");
  headers.set("X-Request-Id", id);
  return new Response(JSON.stringify(body), { status: doResponse.status, headers });
}

export function createApp(env: Env): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  // Order matters:
  //   1. CORS first — short-circuits OPTIONS preflights with 204 before the
  //      error-envelope middleware can produce JSON, which would be wrong
  //      for a CORS preflight.
  //   2. Request id — every other middleware/handler reads `c.get("requestId")`.
  //   3. Logging — wraps `next()` so it observes the final status / latency.
  //   4. Error envelope — innermost so it can catch handler throws and
  //      synthesise the ADR-0007 §2 JSON shape.
  app.use(
    "*",
    cors({ allowedOriginsEnv: env.CORS_ALLOWED_ORIGINS }),
    requestId(),
    logging({ hmacSecret: env.LOG_HMAC_SECRET }),
  );
  app.onError(errorEnvelope());

  // Smoke endpoint. No auth. Always 200.
  app.get("/v1/health", (c) =>
    c.json({
      ok: true,
      version: VERSION,
    }),
  );

  // Event-log endpoints (issue #26). Both forward to the per-vault DO; the
  // DO runs the actual auth + tombstone + replay-check logic. Keeping these
  // as thin forwarders here means future per-route concerns (rate limiting in
  // #32, observability hooks) can live in the Worker tier without touching
  // the DO.
  app.post("/v1/vault/:vaultId/events", (c) =>
    forwardToDurableObject(c, validateVaultId(c.req.param("vaultId")), "/events"),
  );
  app.get("/v1/vault/:vaultId/events", (c) =>
    forwardToDurableObject(c, validateVaultId(c.req.param("vaultId")), "/events"),
  );

  // Device-list endpoints (issue #27). Same forwarder pattern; the DO
  // dispatches on method + path. `:deviceId` is opaque to the Worker —
  // the DO's schema check validates the base64url shape.
  app.post("/v1/vault/:vaultId/devices", (c) =>
    forwardToDurableObject(c, validateVaultId(c.req.param("vaultId")), "/devices"),
  );
  app.delete("/v1/vault/:vaultId/devices/:deviceId", (c) =>
    forwardToDurableObject(
      c,
      validateVaultId(c.req.param("vaultId")),
      `/devices/${encodeURIComponent(c.req.param("deviceId"))}`,
    ),
  );

  // Pairing handshake (issue #28). Both endpoints are UNAUTHENTICATED — the
  // unguessable 16-byte pairing token is the only access signal, and the
  // relay never sees plaintext (the sealed blob is opaque base64). Any
  // `Authorization` header on these routes is ignored. See ADR-0003
  // §"pairing handshake" + ADR-0007 §1.
  //
  // PUT: parse + schema-check the body, enforce the decoded-byte cap, then
  // hand the raw base64 string to KV with a 60s TTL. Returns 204 with no
  // body. Re-PUTs with the same token overwrite the entry and reset the
  // TTL — the spec doesn't require 409 idempotency here (see
  // `pairing-token-store.ts` for the rationale).
  app.post("/v1/pairing", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw schemaViolation("body must be valid JSON");
    }
    const parsed = PutPairingRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw schemaViolation("invalid pairing request body");
    }
    const { pairingToken, sealedPayload } = parsed.data;

    // Decoded-byte cap. The Zod regex confirmed the wire charset; here we
    // gate on the actual payload size. ADR-0001 §"blind relay" caps payloads
    // to prevent the unauthenticated PUT being abused as a blob store.
    if (decodedBase64Length(sealedPayload) > MAX_SEALED_PAYLOAD_BYTES) {
      throw schemaViolation(
        `sealedPayload exceeds ${MAX_SEALED_PAYLOAD_BYTES.toString()}-byte cap`,
      );
    }

    const store = new PairingTokenStore(c.env.PAIRING_TOKENS);
    await store.put(pairingToken, sealedPayload);

    // 204 No Content — issue #28 spec. Headers (X-Request-Id, CORS) are
    // applied by middleware.
    return c.body(null, 204);
  });

  // GET: validate path-param shape, look up in KV, 200 with `{ sealedPayload }`
  // or 404 UNKNOWN_PAIRING_TOKEN. Repeatable within the 60s window — KV TTL
  // is the only retention bound (we do NOT delete on read; the PRD says the
  // new device "polls for ≤60s"). ADR-0007 §2: expired tokens surface as
  // UNKNOWN_PAIRING_TOKEN (not EXPIRED_PAIRING_TOKEN, which is reserved for
  // forward-compat).
  app.get("/v1/pairing/:token", async (c) => {
    const token = validatePairingToken(c.req.param("token"));
    const store = new PairingTokenStore(c.env.PAIRING_TOKENS);
    const sealedPayload = await store.get(token);
    if (sealedPayload === null) {
      throw unknownPairingToken();
    }
    return c.json({ sealedPayload });
  });

  // Remaining skeleton vault-routes (schedule-deletion, ...) land in #29.
  // Until then they 404 with the canonical envelope.
  app.all("/v1/vault/:vaultId", () => {
    throw unknownVault();
  });
  app.all("/v1/vault/:vaultId/*", () => {
    throw unknownVault();
  });

  // Catch-all for everything else. The closed `code` enum doesn't include a
  // generic 404; the relay's surface area is fixed by ADR-0007 and unknown
  // paths SHOULD be treated as misconfigured clients. We emit a plain 404
  // with the envelope shape but using `UNKNOWN_VAULT` (the closest match) so
  // the response still parses against `ErrorEnvelopeSchema` at the client
  // boundary.
  app.notFound((c) => {
    const id = c.get("requestId");
    c.header("X-Request-Id", id);
    return c.json(
      {
        error: "not_found",
        code: "UNKNOWN_VAULT",
        requestId: id,
      },
      404,
    );
  });

  return app;
}
