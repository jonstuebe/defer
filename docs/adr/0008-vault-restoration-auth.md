# Vault restoration authentication at the relay

A returning user with no working paired devices recovers their vault by entering their 24-word recovery mnemonic (PRD US #8). Today's relay does not specify how that fresh device proves vault-key ownership to authenticate against an already-initialized Durable Object — ADR-0007 §1's first-write self-registration covers only previously-unknown `vaultId`s. This ADR pins the recovery handshake.

This ADR builds directly on ADR-0003's crypto baseline (vault key = 32 random bytes, vault ID = HKDF(vaultKey, salt="defer-vault-id", length=16)), ADR-0006's canonical-bytes and MAC conventions, and ADR-0007 §1–§2's bootstrap / error envelope rules. Issue #53 (and its parent #4) are closed by this ADR.

## Context

A fresh install on a brand-new device — no paired peer to seal a `(vaultKey, deviceAuthToken)` blob — has only the user's typed mnemonic. From the mnemonic it can derive:

- The 32-byte **Vault key** via BIP-39 decode (`@defer/core/recovery-mnemonic`).
- The 16-byte **Vault ID** via HKDF (`@defer/core/recovery-mnemonic.deriveVaultIdFromKey`).

It cannot derive a valid **Device auth token** for this vault — those are stored in the per-vault Durable Object's device-list table, populated by either ADR-0007 §1's first-write bootstrap or by the ADR-0003 pairing handshake. A restoring device hits an already-initialized DO with a fresh locally-minted token; the relay's `/events` endpoint sees an unknown bearer and returns `401 INVALID_TOKEN` per ADR-0007 §2.

The restoring device needs a way to demonstrate vault-key ownership to the relay so a fresh device auth token can be added to the device list. The relay must do this without ever learning the vault key (blind-relay invariant, ADR-0001).

## Threat model

The mechanism must defeat:

- **Bearer-token forgery.** An attacker who guesses or steals a device auth token must not be able to use restoration to escalate into a permanent registered device.
- **Replay.** An attacker who observes a successful recovery handshake on the wire (TLS-protected, but assume the worst) must not be able to replay it to mint themselves a token. The relay must consume a fresh server-chosen nonce per attempt.
- **Vault enumeration.** An attacker with a list of `vaultId`s must not be able to discover which are restorable. The relay's response shape must not leak whether a given `vaultId` exists when no mnemonic is presented. (Per ADR-0007 §2's existing 404 `UNKNOWN_VAULT` rule, an attacker can already probe vault-existence via `GET /events`; this ADR doesn't widen that surface.)
- **Relay-side MAC oracle.** The relay must not be capable of producing a valid MAC over canonical bytes that would convince a paired client that this restoration event is legitimate. The MAC is over a server-chosen nonce only; it is not over any payload the client would re-verify later.

## Decision: two-step challenge / response (option A)

A fresh device performs a two-step authenticated registration:

1. **Challenge.** The device GETs `/v1/vault/:vaultId/recovery-challenge`. The relay returns a fresh 32-byte server-chosen nonce.
2. **Claim.** The device POSTs `/v1/vault/:vaultId/recovery-claim` carrying its new `deviceId`, its new `deviceAuthToken`, and an HMAC-SHA256 over canonical bytes (per ADR-0006) keyed by the **Vault key**. On verification, the relay adds the new token to the device list and returns `200 { ok: true }`.

The MAC is the proof of vault-key ownership; the server nonce is the replay defence; the relay never sees the vault key.

### Wire shapes

#### `GET /v1/vault/:vaultId/recovery-challenge`

Unauthenticated (no bearer header expected). The endpoint exists on every initialized vault.

Response on 200:

```json
{ "challengeNonce": "<43-char base64url, 32 random bytes>", "expiresAt": <ms unix> }
```

The relay generates 32 random bytes via the platform CSPRNG, stores `(challengeNonce → expiresAt)` in the per-vault DO with a 60-second TTL, and returns the encoded value plus the expiry. The TTL matches the pairing-token TTL pinned by ADR-0003 §"Pairing handshake" — both are short-lived single-use tokens with the same threat profile.

Response on 404 `UNKNOWN_VAULT`: the vault has not been initialized (ADR-0007 §1). Same envelope shape as every other 404.

Response on 410 `VAULT_DELETED`: the DO has fired its deletion alarm (ADR-0005 §"deletion alarm"). Same shape as the existing post-deletion tombstones.

The endpoint is rate-limited at the same per-vault budget as `POST /events` (ADR-0007 §3, issue #32): bounded `challenges/min` per `vaultId`.

#### `POST /v1/vault/:vaultId/recovery-claim`

Unauthenticated (no bearer header expected — the MAC is the auth signal). Body:

```json
{
  "challengeNonce": "<43-char base64url>",
  "deviceId": "<22-char base64url, 16 random bytes>",
  "deviceAuthToken": "<22-char base64url, 16 random bytes>",
  "mac": "<43-char base64url, 32-byte HMAC-SHA256>"
}
```

Canonical bytes input to the HMAC (per ADR-0006 §3, big-endian length prefixes elided in favour of fixed-length fields):

```
"defer-recovery-claim-v1" (UTF-8) ‖ vaultId (16) ‖ challengeNonce (32) ‖ deviceId (16) ‖ deviceAuthToken (16)
```

The leading domain-separation string keeps this MAC distinguishable from every other vault-key-MAC use (vault-deletion signing per ADR-0006 §5, future protocol extensions). The fields are concatenated raw; no length prefixes are needed because every field is fixed-length and the concatenation order is unambiguous.

The relay:

1. Looks up `(vaultId, challengeNonce)` in the per-vault DO state. If absent or expired → `404 UNKNOWN_RECOVERY_CHALLENGE`.
2. **Removes** the challenge entry immediately, before any further checks (consume-on-attempt). This bounds attacker retries to one per issued challenge; the challenge cannot be replayed by either the legitimate user or an attacker.
3. Verifies that the supplied `deviceAuthToken` is not already in the device list (it shouldn't be — locally-minted tokens are random) → `409 DEVICE_ALREADY_REGISTERED` if it is.
4. **Cannot** verify the MAC itself (the relay has no vault key). Accepts the MAC as opaque bytes, registers the device, and forwards the MAC to the device list for client-side verification on replay (see below).

The MAC validity is enforced indirectly through replay:

- The relay accepts the claim, registers the device auth token, and emits a `DeviceRegistered` event (signed with the new device's auth token; same shape as ADR-0003 pairing flow's `DeviceRegistered`) — except the event payload also carries the `challengeNonce` and the device's `mac` value.
- The next time any paired-and-authenticated device pulls the event log, it sees the new `DeviceRegistered` event, re-computes the canonical bytes with the **Vault key** it holds, verifies the MAC, and — if the MAC is wrong — emits a `DeviceRevoked` for the bogus device that just registered itself.
- A relay that accepts forged MACs would let an attacker briefly appear in the device list, but they'd be revoked on the next pull-and-verify from any legitimately paired device.

This is a deliberate weakening: the relay is blind to the vault key, so it cannot enforce MAC validity online. The MAC validity is **client-enforced on replay**, identical in spirit to how `VaultDeleted` is verified by clients on replay rather than by the relay on emit (ADR-0005 §"signature-on-replay", ADR-0006 §5).

### Two open variants

- **(A.1) Relay rejects on MAC verification failure.** Simpler but requires the relay to hold the vault key — violates ADR-0001. **Rejected.**
- **(A.2) Relay accepts any well-formed MAC; clients verify on replay.** Decision. The "first-write self-registration" precedent from ADR-0007 §1 already trusts the relay to make initial-state decisions it can't fully verify; this is the same pattern.

### What happens when there are no paired devices to revoke a bogus claim

If the user has **zero** working paired devices at the time of restoration, a single attacker claim would succeed unchallenged — the attacker becomes a "paired" device. However, the attacker still cannot decrypt any event (they have no vault key), cannot meaningfully use the access (they can POST garbage but cannot read), and the legitimate restoration MAC over the same `challengeNonce` is now invalid because the relay consumed the challenge on the first attempt.

The legitimate user, on their next attempt, requests a fresh challenge and successfully claims. They then see two `DeviceRegistered` events on replay; their client revokes the bogus one (it has the wrong MAC under their vault key). Net outcome: an attacker can briefly disrupt restoration but cannot read the vault, and the legitimate user eventually wins.

This is acceptable because:

- The attack window requires the attacker to (a) know the unguessable `vaultId` and (b) reach the `recovery-challenge` endpoint between the user's challenge request and claim POST. The `vaultId` knowledge requirement is the same gate as ADR-0007 §1's first-write bootstrap.
- The damage is limited to UX friction (the user retries), not data exposure.
- An alternative — letting the relay reject on MAC failure — would require the relay to hold the vault key, breaking ADR-0001's blind-relay invariant. Not acceptable.

### Why not 410-on-deletion as the only post-deletion response

The DO tombstone from ADR-0005 / ADR-0007 §2 already returns 410 `VAULT_DELETED` for every endpoint after the deletion alarm fires. This ADR adds the recovery endpoints to that table — both return 410 on a deleted vault, identical to every other endpoint. A user trying to restore a deleted vault sees a clear "this vault was deleted" diagnostic; the client SHOULD NOT prompt them to retry.

### Error envelope additions

Two new `code` values are added to the closed enum from ADR-0007 §2:

| code                         | status | meaning                                                                                                                                                |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UNKNOWN_RECOVERY_CHALLENGE` | 404    | The `challengeNonce` doesn't match an outstanding challenge (expired, consumed, or never issued).                                                      |
| `DEVICE_ALREADY_REGISTERED`  | 409    | (Pre-existing code.) The supplied `deviceAuthToken` is already in the vault's device list. Restoring devices should retry with a freshly-minted token. |

`DEVICE_ALREADY_REGISTERED` already exists per `@defer/core/relay-protocol/error-codes.ts`; the recovery-claim endpoint reuses it rather than minting a new code.

### Updates to other rules

- **ADR-0007 §1's unknown-vault response table** grows two rows:

| Endpoint                                       | Response            |
| ---------------------------------------------- | ------------------- |
| `GET    /v1/vault/:vaultId/recovery-challenge` | 404 `UNKNOWN_VAULT` |
| `POST   /v1/vault/:vaultId/recovery-claim`     | 404 `UNKNOWN_VAULT` |

Neither recovery endpoint can bootstrap a vault — restoration only makes sense against an already-initialized DO. A "fresh install with mnemonic, no relay state" is indistinguishable from "fresh install with mnemonic, relay never saw this vault," and the user's correct action in both cases is to start a new vault via the slice-#45 create-vault flow.

- **`@defer/core` adds a `recovery-protocol` sub-export** with the wire schemas and the canonical-bytes encoder. The existing `@defer/core/relay-protocol` sub-module gets two new schemas — `RecoveryChallengeResponseSchema` and `RecoveryClaimRequestSchema` — alongside the existing push/pull/devices/pairing schemas.
- **`@defer/core/crypto` adds `verifyRecoveryClaimMac(vaultKey, claim)`** so the desktop slice (#54) can re-verify on event replay.

### `DeviceRegistered` envelope addition

The `DeviceRegistered` event from CONTEXT.md gains two optional fields in its `data` payload:

```ts
{
  deviceId: string;
  deviceName: string;
  deviceType: string;
  registeredAt: number;
  // Only present when this device registered via recovery-claim:
  recoveryClaim?: {
    challengeNonce: string;     // 43-char base64url, the consumed nonce
    mac: string;                // 43-char base64url, HMAC-SHA256 over canonical bytes
  };
}
```

Clients verify `recoveryClaim.mac` on replay against `recoveryClaim.challengeNonce` plus the rest of the envelope. A `DeviceRegistered` whose `recoveryClaim` field is present and MAC-invalid triggers an immediate `DeviceRevoked` emit by the verifying client. A `DeviceRegistered` without `recoveryClaim` is from the pairing flow (ADR-0003) and skips this check.

This widens the v1 event catalog non-breakingly (optional field per the CONTEXT.md forward-compat rule).

## Considered and rejected

- **(B) Single-shot recovery without a server challenge.** The MAC would be over canonical bytes including the device's own random `nonce`. Without the relay holding state about issued challenges, a relay rate-limit + per-token uniqueness check is the only replay defence. Weaker than (A) — an attacker who observes one successful claim could replay it from a different IP within the rate window. **Rejected.**
- **(C) Relay holds the vault key.** Breaks ADR-0001. **Rejected.**
- **(D) Recovery requires an additional out-of-band factor (email / passphrase).** Adds user friction and requires identity infrastructure the project explicitly avoided. The 16-byte unguessable `vaultId` already provides the entropy for the "knowledge gate"; the mnemonic provides the "ownership" gate. **Rejected.**
- **(E) Relay verifies MAC by holding a public verification key derived from the vault key.** Doesn't work for symmetric HMAC. Would require switching to an asymmetric signing scheme, which ADR-0003 already decided against. **Rejected.**

## Consequences

- The relay grows two endpoints (`recovery-challenge`, `recovery-claim`) and two error codes (`UNKNOWN_RECOVERY_CHALLENGE` is new; `DEVICE_ALREADY_REGISTERED` is reused).
- `@defer/core` grows `recovery-protocol` sub-module + `verifyRecoveryClaimMac` in `crypto`.
- The `DeviceRegistered` event catalog widens by one optional `recoveryClaim` field.
- Slice #54 (vault restoration UI) wires both endpoints + the MAC computation + the on-replay verification.
- The "attacker can briefly disrupt restoration with no paired peers" attack is documented and accepted as the cost of preserving the blind-relay invariant. Mitigations: short challenge TTL (60s), per-vault rate limit, attacker cannot read any vault content even on successful disruption.

## Status

Accepted.
