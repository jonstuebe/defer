import type { DurableObjectNamespace, KVNamespace, RateLimit } from "@cloudflare/workers-types";

// Cloudflare Worker bindings, pinned by `wrangler.toml`. Adding a binding
// requires updating both this type AND the toml in lockstep.
export interface Env {
  VAULT_RELAY: DurableObjectNamespace;
  PAIRING_TOKENS: KVNamespace;
  CORS_ALLOWED_ORIGINS: string;
  LOG_HMAC_SECRET: string;
  // Cloudflare's built-in rate-limit binding for pairing endpoints (issue
  // #32). Declared as `unsafe.bindings.type = "ratelimit"` in `wrangler.toml`.
  // Optional because the `@cloudflare/vitest-pool-workers` test harness does
  // not provision this binding by default; when undefined the relay falls
  // back to an in-memory per-IP token bucket inside `relay-api.ts`. Both
  // paths are documented in `apps/relay/README.md` §"Rate limiting".
  PAIRING_RATE_LIMITER?: RateLimit;
  // Test-only override for the per-page event cap. Lets the events test
  // exercise the `nextSince` non-null path against a small page (e.g. 3)
  // without pushing 1000+ events. Production deployments leave this unset;
  // `MAX_PAGE_SIZE` from `@defer/core/relay-protocol` applies. The runtime
  // value is read inside the DO (`vault-relay.ts#maxPageSize`).
  MAX_PAGE_SIZE_OVERRIDE?: string;
}
