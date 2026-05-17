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
//
// On a 429, we additionally emit:
//
//   "rateLimit": {
//     "bucket":       "events" | "requests" | "pairing",
//     "retryAfterMs": <number>,
//     "clientIpHash": "..."   // for pairing-endpoint 429s only
//   }
//
// The DO stamps `X-Defer-RateLimit-Bucket` + `X-Defer-RateLimit-Retry-After-Ms`
// on its 429 response; the Worker-tier pairing middleware stamps the same
// trio plus `X-Defer-RateLimit-Client-IP` (the raw cf-connecting-ip, which we
// HMAC-hash here for parity with `vaultIdHash`). Both header sets are
// internal — the client only sees the canonical `Retry-After` integer
// seconds.

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

    const line: Record<string, unknown> = {
      ts: new Date(started).toISOString(),
      requestId: c.get("requestId") ?? null,
      method: c.req.method,
      path,
      status: c.res.status,
      latencyMs,
      vaultIdHash,
    };

    if (c.res.status === 429) {
      const bucket = c.res.headers.get("X-Defer-RateLimit-Bucket");
      const retryAfterMsRaw = c.res.headers.get("X-Defer-RateLimit-Retry-After-Ms");
      const clientIpRaw = c.res.headers.get("X-Defer-RateLimit-Client-IP");
      const retryAfterMs =
        retryAfterMsRaw !== null && retryAfterMsRaw !== "" ? Number(retryAfterMsRaw) : null;
      const rateLimit: Record<string, unknown> = {};
      if (bucket !== null) rateLimit.bucket = bucket;
      if (retryAfterMs !== null && Number.isFinite(retryAfterMs)) {
        rateLimit.retryAfterMs = retryAfterMs;
      }
      if (clientIpRaw !== null && clientIpRaw !== "") {
        try {
          rateLimit.clientIpHash = await hashVaultId(clientIpRaw, opts.hmacSecret);
        } catch {
          // Same fall-back as vaultIdHash; never log the raw IP.
        }
      }
      if (Object.keys(rateLimit).length > 0) {
        line.rateLimit = rateLimit;
      }
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  };
