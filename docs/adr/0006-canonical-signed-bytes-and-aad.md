# Canonical signed-bytes, AAD layout, and pre-signed `VaultDeleted`

Three intertwined protocol questions surfaced while planning the Phase 2 relay: what bytes the vault-key MAC actually covers, how AEAD AAD survives the fact that the relay assigns `seq` after the client encrypts, and how the relay can emit a `VaultDeleted` event when it never holds the vault key. This ADR pins all three. It supersedes the relevant lines in ADR-0003 (AAD layout) and tightens the rule in ADR-0005 (relay-emitted `VaultDeleted`). Issue #19 is closed by this ADR.

## 1. Canonical serialization: JCS (RFC 8785)

The bytes that the vault-key HMAC covers are produced by **JSON Canonicalization Scheme** (RFC 8785) over the envelope JSON. JCS over deterministic CBOR (RFC 8949 §4.2) because:

- The event log is JSON-native end-to-end — schemas are Zod, the wire format is JSON, every existing test fixture and CONTEXT.md example is JSON. Introducing CBOR purely as a signing envelope means clients carry two serializers and a JSON↔CBOR conversion step on every sign/verify, with no observable benefit to a single-user read-later app.
- Debuggability: a developer staring at a captured envelope in a log line can hash it themselves with a one-line JCS shim and reproduce the MAC. CBOR forces hex dumps or a decoder in the loop.
- Library availability across the three runtimes pinned by ADR-0004 (V8/WebCrypto, Hermes, libsodium-wasm) is better for JCS — small, dependency-free implementations exist in TS, Rust, and pure-WASM. The dCBOR ecosystem is real but smaller, and the encoder/decoder asymmetry around tagged values is a foot-gun we don't need.
- The event log is append-only forever (ADR-0002), so any signing-format change is a hard fork. Picking the format with the boring, debuggable, ecosystem-default representation is the conservative call.

Trade-off being accepted: JCS is JSON-shaped and therefore inherits JSON's number-precision limits. All numeric fields in the v1 event catalog (`seq`, `timestamp`, `scheduledFor`, `deletedAt`, `registeredAt`, `savedAt`) are integers comfortably within `Number.MAX_SAFE_INTEGER`, so this is a non-issue for the catalog as specified. New numeric fields added in future event types MUST stay within `Number.MAX_SAFE_INTEGER`; if a `bigint` field is ever needed it must ride on the wire as a string.

## 2. Signed-bytes rule

For each vault-key-MAC'd event (`VaultDeletionScheduled`, `VaultDeletionCancelled`, `VaultDeleted`), the MAC is computed as:

```
mac = HMAC-SHA256(vaultKey, JCS(envelope without `signature` and without `seq`))
```

Concretely: take the envelope object, **remove the `signature` field and the `seq` field**, JCS-canonicalize the remainder, HMAC the resulting bytes with the 32-byte vault key. Encode the MAC for the wire (see §3) and assign it to `signature`.

Why both `signature` and `seq` are stripped:

- `signature` — you can't sign over yourself. Standard.
- `seq` — ADR-0002 says the relay assigns `seq` on arrival. The client doesn't know it at sign time, so it cannot be part of the signed bytes. The relay stamps `seq` onto the envelope as it persists; verifiers MUST strip `seq` again before recomputing the MAC.

This rule applies to all three vault-key-MAC'd events and to the **pre-signed** `VaultDeleted` payload (§5).

## 3. Wire encoding of the MAC: base64url, no padding

The `signature` field on the wire is the 32-byte HMAC-SHA256 output encoded as **base64url without padding**. 32 bytes → 43 base64url characters unpadded. Schemas pin the exact regex:

```
^[A-Za-z0-9_-]{43}$
```

Base64url over base64 because the envelope can appear in URLs, log lines, and JSON contexts where `+`, `/`, and `=` are friction. No padding because the length is fixed by the algorithm; padding would be one character of redundancy that adds nothing.

`packages/core/src/events/vault-events.ts` tightens its `signature` field from `z.string().min(1)` to this regex as part of this ADR's follow-up (already in this PR).

## 4. AAD vs. relay-assigned `seq` — resolution: `clientNonce` (option A)

ADR-0003 currently says event AAD is `vaultId || deviceId || sequenceNumber`. ADR-0002 says `seq` is relay-assigned. Both cannot be true: the client finalizes AEAD before POST, and the relay stamps `seq` only on arrival. ADR-0003's AAD line is wrong and is superseded by this ADR.

### Decision

The AAD becomes:

```
vaultId || deviceId || clientNonce
```

where `clientNonce` is a **16-byte, cryptographically random value chosen by the client per event** and carried in **cleartext on the envelope** (new field — see §4.3).

### Considered and rejected

- **(B) Two-phase POST.** Client reserves a `seq`, then encrypts with the reserved `seq` in AAD, then POSTs. Adds a round-trip on every event emission, which is especially painful for the thin senders (Chrome/Safari extensions, iOS Share Extension) where the whole save flow is one short-lived process and an extra round-trip doubles the failure surface for transient network issues. Also adds protocol state at the relay (reserved-but-unfilled `seq` slots) for no security gain over (A).
- **(C) Drop AAD ordering protection entirely.** Rely on the event log's append-only property + the relay's signed `seq` envelope as the only ordering binding. This weakens the threat model against a malicious or buggy relay — exactly the threat model that motivated ADR-0001's blind-relay framing. Rejected.

### Why (A) is sound

The threat we're defending against with AAD is a malicious relay swapping or replaying ciphertext blobs across events. Binding the ciphertext to a client-chosen 128-bit nonce achieves this: the relay cannot construct a different ciphertext that decrypts under the same AAD without a vault-key oracle, and it cannot reuse a previously-seen `(deviceId, clientNonce)` pair because the relay itself enforces uniqueness (see §4.2).

Replay protection becomes a two-sided check:

1. **Relay-side:** on `POST /events`, reject any event whose `(deviceId, clientNonce)` pair has already been accepted for this vault. This is a per-vault DO keyspace lookup; the relay already has a per-vault DO. Storage cost is 16 bytes × event count, which fits comfortably in the 10GB DO cap (ADR-0001) at realistic usage.
2. **Client-side:** AEAD verification at decrypt time covers `vaultId || deviceId || clientNonce`. A relay that swaps the cleartext `clientNonce` will produce an AEAD failure on the client. A relay that replays a previously-seen blob under a fresh `clientNonce` will fail decrypt because the AAD won't match the AAD used at encrypt time.

### 4.1 New envelope layout

A new required field on the pending envelope:

```
clientNonce: 16 random bytes, base64url-encoded without padding (22 chars)
```

The regex for the on-wire value: `^[A-Za-z0-9_-]{22}$` (16 bytes × 4/3 = 21.33 → 22 chars unpadded).

The field rides on the envelope as cleartext. It is **not** part of the JCS-signed bytes for the vault-key MAC of `VaultDeletion*` events except as the natural consequence of being a regular envelope field (i.e. if it's on the envelope at sign time, it's covered by the MAC; the MAC strips `signature` and `seq`, not `clientNonce`). This is intentional: the MAC should bind to the same value the AEAD AAD binds to.

### 4.2 Relay-side replay check

When the relay accepts a `POST /events`:

1. Parse and validate envelope shape (`deviceId`, `clientNonce`, etc.).
2. Look up `(deviceId, clientNonce)` in the per-vault DO storage. If present, reject with `409 Conflict`.
3. Otherwise, assign `seq`, persist `(deviceId, clientNonce) → seq`, and broadcast.

Step 2 is the only new server-side check vs. the pre-ADR design. The keyspace is per-vault, so there's no cross-vault leak. The check is idempotent under client retry: a client that POSTs the same envelope twice (e.g. on flaky network) gets a deterministic `409` on the second attempt and can treat it as success.

### 4.3 Migration story (no events on the wire yet)

The relay has not shipped. No events exist on the wire. Concretely:

- The pre-ADR `aead.ts` builds AAD as `vaultId || deviceId || seq` (8-byte big-endian `seq`). That implementation will be reworked as a follow-up to take a 16-byte `clientNonce` instead, in tandem with the relay scaffolding.
- The pending-envelope schema gains a required `clientNonce: string` field with the regex above. This is a follow-up too — the schema work in this PR is limited to tightening the `signature` field; the `clientNonce` envelope-field add lives with the relay-scaffolding PR so the schema, the aead module, and the relay land coherently.
- If, despite "no events on the wire," any pre-existing test fixtures or local-dev SQLite blobs need to be reset by a developer, that's a manual `rm -rf` operation. There is no production data to migrate.

This ADR is the source of truth that those follow-up PRs implement against.

## 5. Pre-signed `VaultDeleted`

ADR-0001 forbids the relay from ever holding the vault key. ADR-0005 says the relay emits a signed `VaultDeleted` event when the deletion alarm fires. The only way both hold is if the **scheduling client pre-signs the `VaultDeleted` payload** at schedule time and the relay stores and re-emits it verbatim on alarm fire.

### Decisions

1. **`VaultDeleted.deletedAt` MUST equal `VaultDeletionScheduled.scheduledFor`.** No relay-attached completion timestamp. The relay cannot mutate any signed field, so the only timestamp the relay can faithfully emit is one the client already signed over. Using the originally-scheduled time is honest: clients display "Vault deleted (scheduled for $TIME)" and the displayed and signed value match. If the alarm fires late (transient relay issue), the displayed `deletedAt` is still the scheduled time; that's the right answer — the deletion was authorised for that time.
2. **The `schedule-deletion` request body carries BOTH signed payloads.** The shape is:

   ```jsonc
   POST /vault/:id/schedule-deletion
   {
     "scheduled": <full VaultDeletionScheduled envelope, signed>,
     "deleted":   <full VaultDeleted envelope, signed, with seq omitted>
   }
   ```

   The relay persists `scheduled` immediately as the next event in the log, and stores `deleted` in DO storage under a key like `pendingVaultDeleted`. When the DO alarm fires, the relay reads `pendingVaultDeleted`, assigns the next `seq`, and emits it as the final event. The `scheduled` envelope retains the scheduling device's `deviceId`; the `deleted` envelope uses `deviceId: RELAY_DEVICE_ID` (already pinned by ADR-0005 / `envelope.ts`).

   _Note on signature validation at the relay:_ the relay cannot verify vault-key MACs because it doesn't have the vault key. The relay's job is to enforce shape and replay rules; the _client_ verifies the MAC on receipt. This is consistent with the blind-relay invariant.

3. **Cancellation deletes the stored pre-signed `VaultDeleted`.** `POST /vault/:id/cancel-deletion` causes the relay to (a) cancel the DO alarm, (b) delete the `pendingVaultDeleted` blob, and (c) accept the corresponding signed `VaultDeletionCancelled` event into the log. Step (b) is the new constraint introduced here: without it, a relay that delays processing a cancellation could still emit the pre-signed `VaultDeleted` and weaponize the wipe trigger. After (b), the only way to emit a `VaultDeleted` is to schedule a new deletion (which produces a fresh pre-signed payload).

   If the same vault is scheduled-then-cancelled-then-scheduled-again, the second schedule produces a new pre-signed `VaultDeleted` with a fresh `clientNonce` and a fresh `scheduledFor`; the relay overwrites `pendingVaultDeleted` with the new blob. There is at most one pending pre-signed `VaultDeleted` per vault at any time.

### Why this works under the blind-relay invariant

The relay holds (encrypted at rest by DO storage) a pre-built event whose authenticity the client will verify on receipt. The relay never sees the vault key, never produces a MAC, and never invents `deletedAt`. Its agency is reduced to "emit this blob at this time, or don't emit it because the user cancelled." The malicious-relay attack from ADR-0005 ("relay returns 410 to weaponize a wipe") is still defeated: a forged or absent signed `VaultDeleted` doesn't trigger a wipe.

## Consequences

- ADR-0003's AAD line (`vaultId || deviceId || sequenceNumber`) is superseded; the actual AAD is `vaultId || deviceId || clientNonce`. The line in ADR-0003 has been updated with a back-reference to this ADR.
- ADR-0005's "relay-attached completion timestamp" is superseded; the relay emits a pre-signed payload verbatim, with `deletedAt == scheduledFor`.
- `packages/core/src/events/vault-events.ts` tightens its `signature` regex to `^[A-Za-z0-9_-]{43}$` immediately (this PR).
- `packages/core/src/crypto/aead.ts` and the pending-envelope schema both need to swap `seq` for a 16-byte `clientNonce`. Pinned here; implemented in the relay-scaffolding PR alongside the relay-side replay check.
- The `schedule-deletion` HTTP endpoint shape is pinned by §5: two signed payloads in one request body. The deletion-control-plane PR implements it.
- Issue #19 (the original "canonical signed bytes" question) is fully answered by this ADR and can be closed when this lands. No follow-on protocol question remains open in that thread.
