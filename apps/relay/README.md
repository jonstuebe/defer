# @defer/relay

Cloudflare Worker that fronts the per-vault Durable Object (`VaultRelay`) and
the pairing-token KV namespace. Implements the blind-relay invariant from
ADR-0001 and the transport conventions from ADR-0007 (error envelope, CORS,
request-id, structured logging).

This package is the cross-cutting plumbing slice (issue #25). The actual event
push/pull, device-token, pairing, and deletion endpoints land in subsequent
issues (#26–#30).

## Layout

```
src/
  index.ts             # Worker default export + VaultRelay DO export
  vault-relay.ts       # Durable Object skeleton
  pairing-token-store.ts # KV wrapper
  relay-api.ts         # Hono app with middleware chain + /v1/health
  middleware/
    cors.ts            # ADR-0007 §3
    error-envelope.ts  # ADR-0007 §2
    request-id.ts      # UUID v7 per request
    logging.ts         # JSON log line per request
  log/
    hash-vault-id.ts   # HMAC-SHA256 truncation
  errors.ts            # RelayError + constructors keyed on ERROR_CODES
test/                  # Vitest under @cloudflare/vitest-pool-workers
```

## Build

```sh
pnpm -F @defer/relay build       # wrangler deploy --dry-run
pnpm -F @defer/relay typecheck   # tsc --noEmit
```

## Dev

```sh
pnpm -F @defer/relay dev         # wrangler dev (Miniflare-backed local worker)
curl http://localhost:8787/v1/health
```

## Test

```sh
pnpm -F @defer/relay test        # vitest under @cloudflare/vitest-pool-workers
```

## Deploy (not wired up in this slice)

1. Create the KV namespace and replace `PLACEHOLDER_PRODUCTION_ID` /
   `PLACEHOLDER_PREVIEW_ID` in `wrangler.toml`:
   ```sh
   wrangler kv:namespace create PAIRING_TOKENS
   wrangler kv:namespace create PAIRING_TOKENS --preview
   ```
2. Set the log-hashing secret as a real wrangler secret (do NOT leave the
   placeholder from `[vars]` in production):
   ```sh
   wrangler secret put LOG_HMAC_SECRET
   ```
3. Deploy:
   ```sh
   wrangler deploy
   ```

Deploy automation lives in issue #33; the deploy button + production rollout
are out of scope for this slice.

## ADR cross-refs

- [ADR-0001](../../docs/adr/0001-local-first-blind-cloudflare-relay.md) —
  blind-relay invariant, DO-per-vault topology
- [ADR-0006](../../docs/adr/0006-canonical-signed-bytes-and-aad.md) — AAD
  layout (`vaultId || deviceId || clientNonce`) and pending-envelope schema
- [ADR-0007](../../docs/adr/0007-relay-transport-conventions.md) — vault
  bootstrap, error envelope, CORS, status table, closed `code` enum
