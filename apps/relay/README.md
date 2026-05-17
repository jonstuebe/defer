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

## Device management

The per-vault device-auth-token list lives inside the `VaultRelay` DO,
alongside the event log. Two endpoints (issue #27):

- **`POST /v1/vault/:vaultId/devices`** — body `{ deviceId, deviceAuthToken }`.
  Authed by an existing valid bearer for the vault. Adds the new
  `deviceAuthToken` to the per-vault valid-tokens set and records the
  `deviceId → deviceAuthToken` mapping. This is the existing-device side of
  the pairing handshake: the already-paired device sponsors the new one.
  Duplicate `deviceId` → `409 DEVICE_ALREADY_REGISTERED`.
- **`DELETE /v1/vault/:vaultId/devices/:deviceId`** — authed by any valid
  bearer for the vault, **including** the token belonging to the device being
  revoked (self-revoke). Removes both the token and the `deviceId` mapping;
  subsequent requests carrying that token return `401 INVALID_TOKEN`.

The bootstrap path (`POST /v1/vault/:vaultId/events` against a previously
unknown `vaultId`, ADR-0007 §1) registers the bearer as the first device-
auth-token and captures the **first event's** `envelope.deviceId` as the
owning deviceId. Subsequent events in the same batch may carry other
deviceIds; those do NOT auto-register — they need an explicit `POST /devices`
to gain their own tokens.

### Last-device revoke

Revoking the last remaining device for a vault is allowed and intentional.
After the last token is revoked, the vault becomes unreachable until a new
device is restored — and pairing requires an existing device's token to seal
the payload, so a fresh device can only re-enter the vault via the recovery
mnemonic (ADR-0003). The Durable Object is NOT destroyed by this flow; only
the deletion-alarm path (issue #30) tombstones storage. The DO is therefore
recoverable as long as the user holds the recovery mnemonic.

## ADR cross-refs

- [ADR-0001](../../docs/adr/0001-local-first-blind-cloudflare-relay.md) —
  blind-relay invariant, DO-per-vault topology
- [ADR-0006](../../docs/adr/0006-canonical-signed-bytes-and-aad.md) — AAD
  layout (`vaultId || deviceId || clientNonce`) and pending-envelope schema
- [ADR-0007](../../docs/adr/0007-relay-transport-conventions.md) — vault
  bootstrap, error envelope, CORS, status table, closed `code` enum
