import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";

// Cloudflare Worker bindings, pinned by `wrangler.toml`. Adding a binding
// requires updating both this type AND the toml in lockstep.
export interface Env {
  VAULT_RELAY: DurableObjectNamespace;
  PAIRING_TOKENS: KVNamespace;
  CORS_ALLOWED_ORIGINS: string;
  LOG_HMAC_SECRET: string;
}
