import type { MiddlewareHandler } from "hono";

import type { Env } from "../env.js";
import { RelayError } from "../errors.js";
import {
  consumeOne,
  PAIRING_RATE_LIMIT_PER_MIN,
  PAIRING_RATE_LIMIT_PERIOD_SECONDS,
  type TokenBucketState,
} from "../rate-limits.js";

// Pairing-endpoint global rate limit (issue #32). The two pairing endpoints
// (`POST /v1/pairing`, `GET /v1/pairing/:token`) are UNAUTHENTICATED and not
// vault-scoped, so the per-vault DO buckets don't apply. We cap by client IP
// (`cf-connecting-ip`) so a single misbehaving network can't be used to
// hammer the unauth surface.
//
// Two implementation paths, picked at runtime per request:
//
//   (A) `env.PAIRING_RATE_LIMITER` — Cloudflare's built-in `RateLimit`
//       binding (declared in `wrangler.toml` as `[[unsafe.bindings]]
//       type = "ratelimit"`). Configured to 60 req/60s per key. Used
//       in production.
//   (B) In-memory token bucket per IP, scoped to this Worker isolate.
//       Used in tests (the `@cloudflare/vitest-pool-workers` harness
//       doesn't provision the unsafe RateLimit binding by default) and
//       as a defensive fallback if (A) is misconfigured.
//
// Both paths emit the same internal `X-Defer-RateLimit-*` headers the
// logging middleware reads to render the structured 429 log line.
//
// `cf-connecting-ip` is set by Cloudflare on every request that ingresses
// through their edge; in `wrangler dev` / the vitest pool it may be absent
// (we fall back to `"unknown"` keyed). Production: the header is always
// present and is authoritative.

const PAIRING_PATH_PREFIX = "/v1/pairing";

/**
 * Per-isolate in-memory bucket map used by the fallback path. A `Map` is
 * fine here because:
 *   - The pairing endpoints are unauth, so the address space is bounded by
 *     IPs hitting THIS isolate (Cloudflare load-balances; an attacker can't
 *     pin a flood to a single isolate).
 *   - We don't need cross-isolate consistency. The fallback's contract is
 *     "per-isolate", which under Cloudflare's edge means "approximately
 *     per-IP" at the rates we care about.
 *
 * The map is unbounded in theory; in practice a low-traffic relay sees a
 * small IP set per isolate and Cloudflare recycles isolates regularly so
 * memory growth is self-limiting. A future hardening pass might add an LRU
 * cap; v1 doesn't need it.
 */
const fallbackBuckets = new Map<string, TokenBucketState>();

function getClientIp(headers: Headers): string {
  const ip = headers.get("cf-connecting-ip");
  if (ip === null || ip === "") {
    return "unknown";
  }
  return ip;
}

/**
 * Test affordance — drops the in-memory fallback map. Production code never
 * calls this; tests use it to keep IP buckets from bleeding between cases.
 */
export function __resetPairingFallback(): void {
  fallbackBuckets.clear();
}

/**
 * Hono middleware. Only enforces on `/v1/pairing/*` paths; passes through
 * cleanly on everything else (the per-vault DO buckets handle those).
 */
export const pairingRateLimit = (): MiddlewareHandler<{ Bindings: Env }> => async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // Match both `POST /v1/pairing` (exact) and `GET /v1/pairing/:token`
  // (prefix). Anything outside the pairing surface is none of our business.
  if (path !== PAIRING_PATH_PREFIX && !path.startsWith(`${PAIRING_PATH_PREFIX}/`)) {
    await next();
    return;
  }

  const ip = getClientIp(c.req.raw.headers);

  let allowed = true;
  let retryAfterMs = PAIRING_RATE_LIMIT_PERIOD_SECONDS * 1000;

  const binding = c.env.PAIRING_RATE_LIMITER;
  if (binding !== undefined) {
    // Production path. Cloudflare's binding doesn't surface a retry-after
    // value, so we report the configured period as the worst-case window.
    try {
      const outcome = await binding.limit({ key: ip });
      allowed = outcome.success;
    } catch {
      // If the binding throws, fail open — refusing legitimate pairings
      // because of an internal binding error would be worse than the abuse
      // risk this gate protects against. The error-envelope middleware
      // logs the outer handler; we don't double-log here.
      allowed = true;
    }
  } else {
    // Fallback path (tests + accidental misconfig). Burst capacity =
    // `PAIRING_RATE_LIMIT_PER_MIN` because we want 60 requests/min with no
    // additional headroom on top — matches the binding's `simple.limit`.
    const now = Date.now();
    const current = fallbackBuckets.get(ip);
    const outcome = consumeOne(
      current,
      PAIRING_RATE_LIMIT_PER_MIN,
      PAIRING_RATE_LIMIT_PER_MIN,
      now,
    );
    if (outcome.allowed) {
      fallbackBuckets.set(ip, {
        tokens: outcome.newTokens,
        lastRefillMs: outcome.newLastRefillMs,
      });
    } else {
      allowed = false;
      retryAfterMs = outcome.retryAfterMs;
    }
  }

  if (allowed) {
    await next();
    return;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  throw new RelayError("RATE_LIMITED", `rate limit exceeded on pairing endpoints`, {
    "Retry-After": String(retryAfterSeconds),
    // Internal headers consumed by the logging middleware. The Worker-tier
    // error-envelope middleware sets these on the final response so the
    // logging middleware can read them off `c.res.headers`.
    "X-Defer-RateLimit-Bucket": "pairing",
    "X-Defer-RateLimit-Retry-After-Ms": String(retryAfterMs),
    "X-Defer-RateLimit-Client-IP": ip,
  }).withDetails({ bucket: "pairing", retryAfterMs });
};
