import type { KVNamespace } from "@cloudflare/workers-types";

// Thin wrapper over the `PAIRING_TOKENS` KV binding. No business logic —
// minting, consuming, and TTL handling all land in issue #28. Existing here
// gives the relay-api router a typed shape to inject during testing and
// keeps the KV usage funnelled through a single module so issue #28 doesn't
// have to refactor every endpoint.

export interface PairingTokenStore {
  get(token: string): Promise<string | null>;
  put(token: string, value: string, ttlSeconds: number): Promise<void>;
  delete(token: string): Promise<void>;
}

export function createPairingTokenStore(kv: KVNamespace): PairingTokenStore {
  return {
    async get(token) {
      return kv.get(token);
    },
    async put(token, value, ttlSeconds) {
      await kv.put(token, value, { expirationTtl: ttlSeconds });
    },
    async delete(token) {
      await kv.delete(token);
    },
  };
}
