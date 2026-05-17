# Relay transport conventions: vault bootstrap, error envelope, CORS

Three cross-cutting protocol questions surface on every relay endpoint: how does the very first device for a vault initialize its Durable Object, what shape does an error response take, and which origins / methods / headers does the relay accept under CORS. Pinning all three before the relay scaffold lands keeps the AFK implementers from making ad-hoc, inconsistent calls in each endpoint slice. A single ADR keeps the cross-references tight. Issue #24 is closed by this ADR.

This ADR builds directly on ADR-0006's signed-bytes / AAD / pre-signed-`VaultDeleted` rules. In particular, the "vault is gone" responses pinned in §2 below are the post-deletion-alarm tombstones produced by `state.storage.deleteAll()` (ADR-0005, ADR-0006 §5).

## 1. First-device / vault bootstrap

### Decision: first-write self-registration on `POST /v1/vault/:vaultId/events` (option A)

The first authenticated `POST /v1/vault/:vaultId/events` from a previously-unknown `vaultId` initializes the per-vault Durable Object **and** registers the bearer `Authorization: Bearer <deviceAuthToken>` as the first device-auth-token for that vault. No separate "create vault" call. Subsequent device registration (i.e. pairing a second device) goes through the normal authenticated `/devices` path against an already-initialized DO.

Concretely, the very first event for a vault will typically be a `DeviceRegistered` (per the ADR-0003 pairing-for-first-device flow), but the rule is shape-only: any signed event from the v1 catalog (CONTEXT.md) may be the bootstrapping POST. The relay does not interpret the event payload as part of the bootstrap decision; it sees "POST to an unknown vault, signed by a token I've never seen" and either accepts-and-initializes or rejects on schema/auth-shape grounds.

### Unknown-vault response table

For a `vaultId` whose DO has never been initialized:

| Endpoint                                      | Response                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST   /v1/vault/:vaultId/events`            | 200 — initializes the DO and registers the bearer token as the first device-auth-token |
| `GET    /v1/vault/:vaultId/events`            | 404 `UNKNOWN_VAULT`                                                                    |
| `POST   /v1/vault/:vaultId/devices`           | 404 `UNKNOWN_VAULT`                                                                    |
| `DELETE /v1/vault/:vaultId/devices/:deviceId` | 404 `UNKNOWN_VAULT`                                                                    |
| `POST   /v1/vault/:vaultId/pair`              | 404 `UNKNOWN_VAULT`                                                                    |
| `POST   /v1/vault/:vaultId/schedule-deletion` | 404 `UNKNOWN_VAULT`                                                                    |
| `POST   /v1/vault/:vaultId/cancel-deletion`   | 404 `UNKNOWN_VAULT`                                                                    |

Only `POST /events` can perform first-write self-registration; everything else 404s until the DO exists. This is intentional: every other endpoint presupposes either an existing event log (`GET /events`), an existing device list (`/devices`, `/pair`), or an existing deletion-control state (`/schedule-deletion`, `/cancel-deletion`). None of those are meaningful against a vault that has never been written to.

Once the DO has fired its deletion alarm and called `state.storage.deleteAll()` (ADR-0005, ADR-0006 §5), the DO leaves a 410 tombstone. Every endpoint — **including** `POST /events` — returns `410 VAULT_DELETED` per §2's table. A deleted vault cannot be revived by another first-write; the tombstone is permanent. This closes the malicious-rebirth-after-deletion vector.

### Considered and rejected

- **(B) First-write must be `POST /devices` (unauthenticated for the bootstrap call).** This forces an awkward bootstrap-only unauthenticated endpoint whose security profile is identical to (A): in both cases, the first POST to an unknown vault is accepted on faith ("trust on first use"), and the `vaultId` itself is the unguessability barrier. The threat model is the same (since `vaultId` is 16 bytes from HKDF — see ADR-0003 — and unguessable in practice), but the code path is uglier: every relay handler has to know "am I the special unauthenticated bootstrap call?" rather than "is this a known device-auth-token?". The natural read-path code stays cleaner with (A), where every authenticated POST is authenticated the same way.
- **(C) Existing-device side initializes during pairing.** Doesn't work for the very-first-device case: at vault creation on the first device there is no existing device to register the token. This option is structurally impossible as a sole rule; it could only be a supplement to (A) or (B). It adds no value beyond (A).

### Why TOFU on first POST is acceptable

`vaultId` is 16 bytes derived via HKDF from the 32-byte vault key (ADR-0003: `HKDF(vaultKey, salt="defer-vault-id", length=16)`). 16 bytes of entropy is 2^128 possibilities — unguessable in practice. An attacker cannot enumerate vault IDs to grab a fresh one and POST a bogus first event. The bearer token presented on the first POST becomes the first device-auth-token because the only party in the world who could mint that POST is someone who already holds the vault key (and therefore can derive the vault ID locally). The relay does not, and cannot, verify the cryptographic link between the bearer token and the vault key — that's a blind-relay invariant (ADR-0001) — but it doesn't need to: the bearer's possession of the unguessable `vaultId` is the proof-of-knowledge.

## 2. Error envelope shape + canonical status code table

### Envelope shape

Every non-2xx response from any relay endpoint MUST carry this JSON body:

```json
{ "error": "unauthorized", "code": "INVALID_TOKEN", "requestId": "..." }
```

- `error` — human-readable short category, one of `unauthorized`, `forbidden`, `not_found`, `conflict`, `gone`, `invalid_request`, `rate_limited`, `internal_error`. Picked for triage at a glance; not load-bearing for pattern-matching.
- `code` — machine-readable closed enum (see below). Phase 3+ clients pattern-match against this enum. Adding new codes is a protocol bump.
- `requestId` — UUID v7 generated per request and echoed in the `X-Request-Id` response header so client logs and relay logs can be cross-correlated. (UUID v7 over v4 because UUID v7 sorts lexicographically by time, which makes log scans bearable.)
- `details` — **optional** free-form object carrying code-specific context. Used today by `DUPLICATE_CLIENT_NONCE` (`details.eventIndex` points at the offending event in a rejected batch); future codes may carry whatever shape is useful. Clients SHOULD treat the presence of `details` and its specific keys as informational only — they MUST NOT change their handling of a response based on `details` alone (always pattern-match on `code` first). The envelope schema is parsed non-strict so producers shipping before this addendum continue to validate.

### Status code table

| Status | `error`           | When                                                                                                                                  |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`    | Missing or malformed `Authorization: Bearer` header, or token not known for this vault                                                |
| 403    | `forbidden`       | Token is valid against some vault but not this one                                                                                    |
| 404    | `not_found`       | Unknown vault, unknown device, unknown / consumed pairing token                                                                       |
| 409    | `conflict`        | Idempotency / state conflict (deletion already scheduled, duplicate `clientNonce`)                                                    |
| 410    | `gone`            | Vault deleted (`state.storage.deleteAll()` has fired). Returned on **every** endpoint of that vault, not just `/events` (ADR-0006 §5) |
| 422    | `invalid_request` | Schema violation (Zod parse failure on request body)                                                                                  |
| 429    | `rate_limited`    | Rate limited — `Retry-After` header included                                                                                          |
| 500    | `internal_error`  | Unexpected failure. `code: "INTERNAL_ERROR"` — the only case where `code` is generic                                                  |

### `code` enum (closed set)

The full v1 vocabulary:

| `code`                       | Status | Notes                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INVALID_TOKEN`              | 401    | Bearer missing, malformed, or unknown for this vault                                                                                                                                                                                                                                                                                             |
| `EXPIRED_PAIRING_TOKEN`      | 404    | Pairing token TTL elapsed (ADR-0003: 60s). Returns 404 — the token is treated as if it never existed (prevents probing).                                                                                                                                                                                                                         |
|                              | 410    | Reserved for clients that have already polled this token successfully and the relay deleted it; 410 distinguishes "consumed" from "never existed" only when the relay can prove it. In practice the relay returns 404 for both cases to avoid leaking pairing-token state. The 410 row is documented for completeness; the relay default is 404. |
| `WRONG_VAULT_FOR_TOKEN`      | 403    | Token valid against a different vault                                                                                                                                                                                                                                                                                                            |
| `UNKNOWN_VAULT`              | 404    | DO has never been initialized for this `vaultId`                                                                                                                                                                                                                                                                                                 |
| `UNKNOWN_DEVICE`             | 404    | `deviceId` not in this vault's device list (e.g. on `DELETE /devices/:deviceId`)                                                                                                                                                                                                                                                                 |
| `UNKNOWN_PAIRING_TOKEN`      | 404    | Pairing token not found (never minted, or consumed)                                                                                                                                                                                                                                                                                              |
| `DELETION_ALREADY_SCHEDULED` | 409    | `POST /schedule-deletion` while a `pendingVaultDeleted` is already stored                                                                                                                                                                                                                                                                        |
| `DUPLICATE_CLIENT_NONCE`     | 409    | `POST /events` with a `(deviceId, clientNonce)` already accepted for this vault (ADR-0006 §4.2)                                                                                                                                                                                                                                                  |
| `DEVICE_ALREADY_REGISTERED`  | 409    | `POST /devices` with a `deviceId` already in this vault's device list. `details.deviceId` carries the offending id.                                                                                                                                                                                                                              |
| `VAULT_DELETED`              | 410    | DO has executed `state.storage.deleteAll()`. Returned on every endpoint of that vault.                                                                                                                                                                                                                                                           |
| `SCHEMA_VIOLATION`           | 422    | Request body failed Zod parse                                                                                                                                                                                                                                                                                                                    |
| `RATE_LIMITED`               | 429    | Rate-limit bucket exhausted. Response carries `Retry-After`.                                                                                                                                                                                                                                                                                     |
| `INTERNAL_ERROR`             | 500    | Unexpected exception. Generic; the relay logs the underlying error keyed by `requestId`.                                                                                                                                                                                                                                                         |

`EXPIRED_PAIRING_TOKEN`'s dual status row is the only place where one `code` maps to multiple HTTP statuses. The rule: 404 by default; 410 only if the relay can prove the token previously existed (currently it cannot, so 404 in practice). This is documented for forward-compat if the relay later starts caching consumed-pairing-token markers; clients SHOULD handle both 404 and 410 for `EXPIRED_PAIRING_TOKEN` and treat them identically (the pairing flow restarts either way).

### Ships in `@defer/core` as `relayProtocol`

The enum lives at `packages/core/src/relay-protocol/error-codes.ts` (new module). The barrel re-exports under a `relayProtocol` namespace so client code reads `relayProtocol.ERROR_CODES.UNKNOWN_VAULT` (or imports `ErrorEnvelopeSchema` directly for parsing relay responses). The Zod schema for the envelope parses real responses and rejects unknown `code` values, so a relay that ships a new `code` without a protocol bump trips a client schema error at the boundary — exactly the behaviour the closed-enum guarantee promises.

Tests assert:

1. The closed-enum shape: each entry pairs a `code` string with its canonical HTTP status.
2. `ErrorEnvelopeSchema` parses a real example.
3. `ErrorEnvelopeSchema` rejects unknown `code` values.

## 3. CORS policy

### Decision: explicit allowlist, no credentials, 10-minute preflight cache

The relay accepts cross-origin requests only from known callers (browser extensions, Tauri desktop, and explicitly-opted-in web origins) and uses the bearer token for auth — not cookies.

| Header                             | Value                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Access-Control-Allow-Origin`      | Echo the request `Origin` if it matches the configured allowlist; otherwise omit (browser denies) |
| `Access-Control-Allow-Methods`     | `GET, POST, DELETE, OPTIONS`                                                                      |
| `Access-Control-Allow-Headers`     | `Authorization, Content-Type, X-Request-Id`                                                       |
| `Access-Control-Allow-Credentials` | **omitted**                                                                                       |
| `Access-Control-Max-Age`           | `600` (10 minutes)                                                                                |

### Allowlist

Default allowlist (compiled in):

- `chrome-extension://*` — Chrome MV3 extension (Phase 4)
- `safari-web-extension://*` — Safari Web Extension (Phase 6)
- `tauri://*` — Tauri desktop app

`https://*` is **NOT** in the default. Production web origins must be explicitly opted-in via env var, configured in `wrangler.toml` and loaded by the worker:

```
CORS_ALLOWED_ORIGINS = "https://app.example.com,https://staging.example.com"
```

Comma-separated, exact origin match (no wildcards inside this env var). This keeps a misconfigured fork from accidentally serving `Access-Control-Allow-Origin: *` to arbitrary web pages.

### Why no credentials

`Access-Control-Allow-Credentials: true` is for cookie-bearing or basic-auth flows. The relay uses opaque random 32-byte bearer tokens carried in `Authorization: Bearer` — the browser does not auto-attach those, the calling code explicitly attaches them. Enabling credentials adds cookie attack surface (CSRF, SameSite quirks, third-party cookie blocking) with zero auth benefit, so it stays off.

### Why a 10-minute preflight cache

Long enough to avoid preflight thrash on chatty flows (the Chrome extension may emit a burst of `POST /events` during a busy save session); short enough that an allowlist change propagates within ten minutes of a redeploy. The browser-default `Access-Control-Max-Age` is five seconds, which would mean a preflight before nearly every POST — measurable latency for thin senders.

### CORS is browser-UA enforcement, not server-side auth

The relay does NOT use the `Origin` header as an auth signal. Tokens are opaque 32-byte random values bound to a vault, not to an origin. A native (non-browser) caller — curl, a Rust client, a future portable relay adapter — never sends `Origin` at all and is auth'd purely by `Authorization: Bearer`. CORS is here so browsers don't refuse to talk to us, not because we trust origins.

## Consequences

- The relay-scaffold PR (#25) implements §1's first-write self-registration in the `POST /events` handler and §3's CORS middleware. Both are pinned here.
- `@defer/core` gains a `relayProtocol` sub-module exporting the `ERROR_CODES` enum and the `ErrorEnvelopeSchema` Zod schema. Tests live at `packages/core/src/relay-protocol/tests/error-codes.test.ts`. Client and relay both depend on this single source of truth.
- ADR-0001 has a "See also" footnote pointing at this ADR for wire-level transport conventions.
- CONTEXT.md gains glossary entries for "Vault bootstrap" and "Error envelope" — both new terms introduced here.
- Pairing-token responses use `UNKNOWN_PAIRING_TOKEN` (404) by default. The `EXPIRED_PAIRING_TOKEN` `code` is reserved for the case where the relay can prove the token previously existed; the default implementation does not cache consumed-token markers and therefore always returns 404 / `UNKNOWN_PAIRING_TOKEN`. The pairing-token PR (#28) may revisit this if there's a UX reason to distinguish "expired" from "never existed."
- No event-on-the-wire migration is needed: no production data exists yet (ADR-0006 §4.3 already established this), so the bootstrap rule and error envelope ship clean with the relay scaffold.
