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

  // Skeleton vault-routes. The only thing this slice does is return the
  // correct 404 shape for `/v1/vault/:vaultId/*` (UNKNOWN_VAULT). DO routing
  // and the actual endpoints land with issues #26+.
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
  // boundary. Issue #26+ replaces this with route-specific handlers.
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
