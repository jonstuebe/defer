import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";

// Cloudflare Worker bindings, pinned by `wrangler.toml`. Adding a binding
// requires updating both this type AND the toml in lockstep.
export interface Env {
  VAULT_RELAY: DurableObjectNamespace;
  PAIRING_TOKENS: KVNamespace;
  CORS_ALLOWED_ORIGINS: string;
  LOG_HMAC_SECRET: string;
  // Test-only override for the per-page event cap. Lets the events test
  // exercise the `nextSince` non-null path against a small page (e.g. 3)
  // without pushing 1000+ events. Production deployments leave this unset;
  // `MAX_PAGE_SIZE` from `@defer/core/relay-protocol` applies. The runtime
  // value is read inside the DO (`vault-relay.ts#maxPageSize`).
  MAX_PAGE_SIZE_OVERRIDE?: string;
}
