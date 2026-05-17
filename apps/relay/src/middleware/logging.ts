import type { MiddlewareHandler } from "hono";

import { hashVaultId } from "../log/hash-vault-id.js";

// Per-request structured log line, JSON-encoded to stdout. Shape pinned by
// ADR-0007 / issue #25 acceptance criteria:
//
//   {
//     "ts":         "ISO-8601",
//     "requestId":  "<uuidv7>",
//     "method":     "GET",
//     "path":       "/v1/vault/:vaultId/events",
//     "status":     200,
//     "latencyMs":  3,
//     "vaultIdHash": "abc123..." | null
//   }
//
// `vaultIdHash` is a truncated HMAC-SHA256 of the raw `:vaultId` path
// parameter; never the raw value. If the route doesn't match a `:vaultId`
// path, it's `null`. The HMAC key is `LOG_HMAC_SECRET` from the env.

const VAULT_ID_PATH = /^\/v1\/vault\/([^/]+)(?:\/|$)/;

interface LoggingOpts {
  hmacSecret: string;
}

export const logging =
  (opts: LoggingOpts): MiddlewareHandler =>
  async (c, next) => {
    const started = Date.now();
    await next();
    const latencyMs = Date.now() - started;

    const rawPath = new URL(c.req.url).pathname;
    const match = VAULT_ID_PATH.exec(rawPath);
    let vaultIdHash: string | null = null;
    let path = rawPath;
    if (match !== null) {
      const rawVaultId = match[1]!;
      try {
        vaultIdHash = await hashVaultId(rawVaultId, opts.hmacSecret);
      } catch {
        // If hashing fails for any reason (it shouldn't — WebCrypto is sync-
        // enough), fall back to null rather than leaking the raw vaultId.
        vaultIdHash = null;
      }
      // Redact the raw vaultId from the logged path. The blind-relay invariant
      // (ADR-0001) demands the raw vaultId never appear in logs in any form.
      path = rawPath.replace(rawVaultId, ":vaultId");
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date(started).toISOString(),
        requestId: c.get("requestId") ?? null,
        method: c.req.method,
        path,
        status: c.res.status,
        latencyMs,
        vaultIdHash,
      }),
    );
  };
