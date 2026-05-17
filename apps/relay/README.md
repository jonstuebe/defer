# @defer/relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jonstuebe/defer/tree/main/apps/relay)

Bring-Your-Own blind relay for [defer](https://github.com/jonstuebe/defer).
Tracking issue: [#33](https://github.com/jonstuebe/defer/issues/33).

## 1. What this is

`defer-relay` is a Cloudflare Worker + per-vault Durable Object + Workers KV
namespace. It stores encrypted blobs and routes them between paired devices.
It **never sees plaintext, URLs, titles, tags, or content** — only opaque
vault IDs and ciphertext. See
[ADR-0001](../../docs/adr/0001-local-first-blind-cloudflare-relay.md) for the
blind-relay invariant this guarantees.

## 2. Quick deploy (one-click)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jonstuebe/defer/tree/main/apps/relay)

Clicking the button takes you to Cloudflare's deploy UI, which will ask for:

- Access to your Cloudflare account (the standard OAuth handshake).
- A worker name (defaults to something like `defer-relay`; rename freely).
- The route / `*.workers.dev` subdomain to publish under.
- Permission to create a KV namespace bound as `PAIRING_TOKENS`.
- Permission to run the `VaultRelay` Durable Object migration (`v1`,
  `new_classes = ["VaultRelay"]`).

Cloudflare reads `apps/relay/wrangler.toml` from this repo's `main` branch,
provisions everything in your account, and boots the worker. When it
finishes, you get a public `https://<your-worker-name>.<your-subdomain>.workers.dev`
URL. Hit `GET /v1/health` on it to confirm it responds with
`{ "ok": true, "version": "..." }`.

**Caveats:**

- The button uses `wrangler.toml` from `main`, which is configured for the
  upstream defer project's KV / DO IDs. Cloudflare will create fresh KV
  namespaces in your account, but the IDs in the deployed config will be
  yours, not the placeholders.
- After deploy, set the log-hash secret for production logging:
  `wrangler secret put LOG_HMAC_SECRET` (32+ random bytes). Until you do,
  the worker falls back to the placeholder dev secret, which means log
  correlation hashes are not cryptographically separated from any other
  deploy using the default.

## 3. Manual deploy

For users who don't trust one-click buttons. Zero → deployed worker:

1. Clone the repo and enter the relay package:

   ```sh
   git clone https://github.com/jonstuebe/defer.git
   cd defer/apps/relay
   ```

2. Install dependencies. The repo pins pnpm via `packageManager` in the
   root `package.json`; corepack provisions the right version:

   ```sh
   corepack enable pnpm
   pnpm install   # from the repo root
   ```

3. Authenticate against Cloudflare:

   ```sh
   pnpm exec wrangler login
   ```

4. Copy the template and edit in your IDs:

   ```sh
   cp wrangler.toml.template wrangler.toml
   ```

5. Create the KV namespace and its preview sibling, then paste the returned
   IDs into `wrangler.toml`'s `id` and `preview_id` fields:

   ```sh
   pnpm exec wrangler kv namespace create PAIRING_TOKENS
   pnpm exec wrangler kv namespace create PAIRING_TOKENS --preview
   ```

   (Wrangler 3.x also accepts the older `kv:namespace create` form; both
   work with the version pinned in `package.json`.)

6. Set the production log-hash secret (paste 32+ random bytes when prompted):

   ```sh
   pnpm exec wrangler secret put LOG_HMAC_SECRET
   ```

   Then remove the `LOG_HMAC_SECRET` line from `[vars]` in your
   `wrangler.toml` so the secret is the only source.

7. Deploy:

   ```sh
   pnpm exec wrangler deploy
   ```

8. Smoke-test against your new URL:

   ```sh
   curl https://<your-worker>.<your-subdomain>.workers.dev/v1/health
   # → {"ok":true,"version":"..."}
   ```

## 4. Configuring clients to use your relay

Each client surface (Tauri desktop, Chrome extension, Safari extension, iOS
Share Extension, RN/Expo mobile) stores the relay URL in its local settings.
The default in v1 is the public defer relay; pointing a client at your own
relay requires editing the per-surface settings file.

Phase 3–6 clients land in subsequent milestones, so the exact settings
location is documented per surface as those clients ship. For v1, expect
a single `RELAY_URL` env var or settings entry per client.

**Migration caveat:** events already pushed to your previous relay stay
there. See §7 below for the rotation workflow.

## 5. What the relay sees

What the relay **does** see:

- Opaque `vaultId` (16-byte HKDF-derived ID from the vault key; not
  reversible to the key itself).
- Opaque `deviceAuthToken` bearer (a random per-device token, used to
  authorize requests — not the device's signing key).
- AEAD-encrypted event ciphertext.
- Base64url-encoded `clientNonce` for replay protection.
- Monotonic `seq` numbers per vault.
- Signed envelopes for vault-control events (relay verifies signatures but
  cannot decrypt the encrypted body).

What the relay does **not** see:

- The vault key.
- Item URLs, titles, tags, body text, or any decryptable content.
- The recovery mnemonic.
- The device signing key.

Authoritative references:

- [ADR-0001](../../docs/adr/0001-local-first-blind-cloudflare-relay.md) — the
  blind-relay invariant.
- [`packages/core/src/relay-protocol/wire.ts`](../../packages/core/src/relay-protocol/wire.ts)
  — the exact wire schemas for every field the relay touches.

## 6. What the relay costs

Pricing snapshot from Cloudflare as of the date this PR opened — check
<https://developers.cloudflare.com/workers/platform/pricing/> for current
rates.

**Cloudflare pricing (relevant tiers):**

| Resource          | Free tier            | Paid tier                                 |
| ----------------- | -------------------- | ----------------------------------------- |
| Workers requests  | 100,000 / day        | $5/mo + $0.30 per million above 10M       |
| Durable Objects   | (Paid plan required) | $0.20/M reads, $1/M writes, $0.20/GB-mo   |
| Workers KV reads  | 100,000 / day        | $5/mo + $0.50 per million reads above 10M |
| Workers KV writes | 1,000 / day          | $5/mo + $5 per million writes above 1M    |

**Estimates for a single user:**

- **Typical** (~50 events/day, ~100 reads/day, ~25 KB stored): well under
  every free-tier cap. **$0/month.**
- **Power user** (~500 events/day, ~1,000 reads/day, ~250 KB stored):
  ~1,500 requests/day vs. the 100K daily Workers cap. **$0/month.**
- **Heavy / multi-user** (~50 users on one relay): still well within
  Workers Free for requests, but DO usage now requires the Workers Paid
  plan ($5/mo flat). DO read/write volume at this scale is rounding
  error on the per-million unit prices. **~$5/month** for the paid-plan
  baseline; effectively zero marginal cost per user.

For personal BYO use, the relay is **free** on Cloudflare's Workers Free
plan as long as you don't add Durable Objects (Workers Paid only). Since
defer uses DO, you'll need the $5/mo Workers Paid plan — but the relay
itself adds no meaningful cost above that baseline.

## 7. Migration: rotating from the public relay to your own

**Honest answer: events stay on the old relay.** The new relay starts
fresh.

If you want full continuity, the workflow is:

1. Pair a fresh device against the **new** relay using the recovery
   mnemonic (which yields the vault key + a new `deviceAuthToken` for the
   new relay).
2. The new device derives the same `vaultId` and rebuilds the event log
   locally from the mnemonic-derived key material; nothing has to flow
   through either relay for the data to land.
3. Unpair from the old relay (revoke that device's token there).
4. New events go to the new relay only. The old relay's event-log entries
   stay until you delete that vault (§"Operational notes" below) or just
   abandon it.

A future re-encrypt-and-replay migration tool may ship in a later phase
to copy historical events from one relay to another; not in v1.

## 8. Operational notes

### Durable Object storage caps

Cloudflare imposes a **10 GB per DO** limit. At ~500 bytes/event, that's
~20 million events per vault — effectively unlimited for a single user.

### Rate-limit defaults

Tunable by editing constants in
[`src/rate-limits.ts`](src/rate-limits.ts) and redeploying. Defaults:

| Bucket   | Limit                | Scope                                                |
| -------- | -------------------- | ---------------------------------------------------- |
| events   | 600 / min / vault    | `POST /v1/vault/:vaultId/events`                     |
| requests | 1,200 / min / vault  | All other authenticated per-vault endpoints + events |
| pairing  | 60 / min / client IP | `POST /v1/pairing`, `GET /v1/pairing/:token`         |

`POST /v1/events` consumes from both `events` AND `requests` atomically;
the deletion alarm fires internally and does NOT consume bucket tokens.
See "Rate limiting" below for full semantics.

### Logs

Structured JSON to Cloudflare's logging surface. Tail with `wrangler tail`
or stream from the dashboard. Each request emits one line:

- `ts`, `requestId` (UUID v7), `method`, `path`, `status`, `latencyMs`
- `vaultIdHash` — HMAC-SHA256 of the vaultId under `LOG_HMAC_SECRET`
- For 429s, a `rateLimit` block carrying `bucket` and `retryAfterMs`
- For pairing 429s, `clientIpHash` (HMAC of `cf-connecting-ip`) instead
  of `vaultIdHash` — raw IPs never appear in logs.

### Vault deletion

Deletion is a **48-hour-delayed wipe** (see
[ADR-0005](../../docs/adr/0005-vault-deletion-time-delayed-cancellation.md)).
Two phases:

- `POST /v1/vault/:vaultId/schedule-deletion` arms a DO alarm and stores a
  pre-signed `VaultDeleted` envelope at `meta:pendingVaultDeleted`.
- `POST /v1/vault/:vaultId/cancel-deletion` clears the pending envelope
  and cancels the alarm. Both events propagate via `GET /events` so paired
  devices see the cross-device "deletion scheduled" banner and can clear it.

The relay rejects `scheduledFor` strictly older than `now - 5min` as replay
(`422 SCHEMA_VIOLATION`, `details.reason === "scheduled_in_past"`). The
5-minute window absorbs realistic clock skew.

### Inspecting a stuck deletion alarm

Stream worker logs to watch alarms fire:

```sh
pnpm exec wrangler tail
```

Alarm-fire log lines come from inside the DO and carry the same structured
fields as request logs. If an alarm fails to fire, the per-DO state can be
inspected via the Cloudflare dashboard (Workers → Durable Objects → your
namespace → object instance), and forced rerun via a redeploy or by
arming/cancelling/re-arming through the API.

### Device management & last-device revoke

The per-vault device-auth-token list lives inside the `VaultRelay` DO,
alongside the event log:

- **`POST /v1/vault/:vaultId/devices`** (issue #27) — body
  `{ deviceId, deviceAuthToken }`. Authed by an existing valid bearer for
  the vault. Adds the new `deviceAuthToken` to the per-vault valid-tokens
  set and records the `deviceId → deviceAuthToken` mapping. This is the
  existing-device side of the pairing handshake: the already-paired device
  sponsors the new one. Duplicate `deviceId` → `409 DEVICE_ALREADY_REGISTERED`.
- **`DELETE /v1/vault/:vaultId/devices/:deviceId`** — authed by any valid
  bearer for the vault, **including** the token belonging to the device
  being revoked (self-revoke). Removes both the token and the `deviceId`
  mapping; subsequent requests carrying that token return
  `401 INVALID_TOKEN`.

The bootstrap path (`POST /v1/vault/:vaultId/events` against a previously
unknown `vaultId`, ADR-0007 §1) registers the bearer as the first
device-auth-token and captures the first event's `envelope.deviceId` as
the owning deviceId. Subsequent events in the same batch may carry other
deviceIds; those do NOT auto-register — they need an explicit
`POST /devices` to gain their own tokens.

**Last-device revoke.** Revoking the last remaining device for a vault is
allowed and intentional. After the last token is revoked, the vault
becomes unreachable until a new device is restored — and pairing requires
an existing device's token to seal the payload, so a fresh device can only
re-enter the vault via the recovery mnemonic (ADR-0003). The Durable
Object is **not** destroyed by this flow; only the deletion-alarm path
tombstones storage. The DO is therefore recoverable as long as the user
holds the recovery mnemonic.

### Rate limiting (full semantics)

Per-vault token buckets live inside the Durable Object and persist to DO
storage so they survive eviction. Both refill linearly at the configured
per-minute rate up to the configured capacity. State keys:
`meta:rate:events`, `meta:rate:requests`.

`POST /events` consumes from BOTH buckets in one shot. The check is
atomic — both must pass before either decrements; if one fails, the OTHER
is NOT decremented and the 429 response identifies which bucket tripped
(`details.bucket`). A pull-storm that exhausts `requests` DOES block
subsequent `POST /events` writes; treating an exhausted `requests` bucket
as a hard stop for writes is intentional, since pull-storm on a vault
means the device is misbehaving.

The DO's `fetch()` dispatches in this fixed order:

1. **Tombstone check** — a tombstoned vault returns `410 VAULT_DELETED`
   on every endpoint (ADR-0007 §2). Wins over rate-limit.
2. **Rate-limit check** — returns `429 RATE_LIMITED` with `Retry-After`
   and `details: { bucket, retryAfterMs }`. Runs BEFORE auth so a
   misbehaving anonymous caller can't burn a 401-storm into a free DoS.
3. **Auth + handler** — `401 INVALID_TOKEN` lives here.

The health endpoint is OUTSIDE vault routing; it never reaches the DO and
never consumes tokens.

The pairing path uses Cloudflare's native `RateLimit` binding
(`PAIRING_RATE_LIMITER`) in production and an in-memory fallback in the
vitest-pool-workers test harness. 429s on the pairing path include
`Retry-After: <integer seconds>` and the canonical envelope with
`details: { bucket: "pairing", retryAfterMs }`.

### Filing BYO-relay issues

Report bugs and ask questions at
<https://github.com/jonstuebe/defer/issues> with the `apps/relay` label.

## ADR cross-refs

- [ADR-0001](../../docs/adr/0001-local-first-blind-cloudflare-relay.md) —
  blind-relay invariant, DO-per-vault topology
- [ADR-0002](../../docs/adr/0002-event-log-sync.md) — event-log sync,
  DO storage caps
- [ADR-0005](../../docs/adr/0005-vault-deletion-time-delayed-cancellation.md) —
  48-hour-delayed deletion flow
- [ADR-0006](../../docs/adr/0006-canonical-signed-bytes-and-aad.md) — AAD
  layout (`vaultId || deviceId || clientNonce`) and pending-envelope schema
- [ADR-0007](../../docs/adr/0007-relay-transport-conventions.md) — vault
  bootstrap, error envelope, CORS, status table, closed `code` enum

## Local development

```sh
pnpm -F @defer/relay build       # wrangler deploy --dry-run
pnpm -F @defer/relay typecheck   # tsc --noEmit
pnpm -F @defer/relay dev         # wrangler dev (Miniflare-backed local worker)
pnpm -F @defer/relay test        # vitest under @cloudflare/vitest-pool-workers
curl http://localhost:8787/v1/health
```
