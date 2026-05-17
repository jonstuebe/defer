import type { Context } from "hono";
import { Hono } from "hono";

import type { Env } from "./env.js";
import { cors } from "./middleware/cors.js";
import { errorEnvelope } from "./middleware/error-envelope.js";
import { logging } from "./middleware/logging.js";
import { requestId } from "./middleware/request-id.js";
import { unknownVault } from "./errors.js";

// Hono context variables surfaced by the middleware chain.
type Variables = {
  requestId: string;
};

const VERSION = "0.0.0";

// Vault IDs are short opaque strings on the wire (16-byte HKDF output from
// ADR-0003, typically rendered as 32 hex chars or 22 base64url chars). The
// Worker route accepts any non-empty string and uses it as the DO name. The
// only validation the relay does is the schema check on the request body —
// vault IDs themselves are not parsed at the relay (the unguessable HKDF
// output is the auth signal, per ADR-0007 §1).
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
    forwardToDurableObject(c, c.req.param("vaultId"), "/events"),
  );
  app.get("/v1/vault/:vaultId/events", (c) =>
    forwardToDurableObject(c, c.req.param("vaultId"), "/events"),
  );

  // Device-list endpoints (issue #27). Same forwarder pattern; the DO
  // dispatches on method + path. `:deviceId` is opaque to the Worker —
  // the DO's schema check validates the base64url shape.
  app.post("/v1/vault/:vaultId/devices", (c) =>
    forwardToDurableObject(c, c.req.param("vaultId"), "/devices"),
  );
  app.delete("/v1/vault/:vaultId/devices/:deviceId", (c) =>
    forwardToDurableObject(
      c,
      c.req.param("vaultId"),
      `/devices/${encodeURIComponent(c.req.param("deviceId"))}`,
    ),
  );

  // Remaining skeleton vault-routes (pair, schedule-deletion, ...)
  // land in #28, #29. Until then they 404 with the canonical envelope.
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
