# Crypto baseline: libsodium symmetric vault key + ephemeral X25519 pairing

One 32-byte symmetric key per vault, used with **XChaCha20-Poly1305** (via libsodium) to encrypt every event. The 24-byte nonce means devices can use random nonces without coordinating a counter, which matters because RN/Tauri/extension surfaces don't share state cleanly.

**Pairing** uses an ephemeral X25519 keypair generated on the _new_ device, displayed as a QR. The existing device scans, asks the user to confirm, then seals `(vaultKey, deviceAuthToken)` to the ephemeral public key via `crypto_box_seal` and posts the ciphertext to the relay under a short-lived pairing token (60s TTL). The new device polls, unseals, and now has the vault key — it derives `vaultId` from `vaultKey` locally via HKDF. The QR itself never carries the secret — a shoulder-surfing photo gets only a public key.

**Recovery** is a 24-word BIP-39 mnemonic encoding the 32-byte vault key (standard BIP-39 with checksum). The 16-byte vault ID is derived from the vault key via HKDF with a fixed salt (`"defer-vault-id"`), so a single standard mnemonic carries everything needed to restore. Shown once at vault creation; the user records it. Sufficient to restore on a brand-new device when no other device is available.

**Per-device auth at the relay.** Each device has its own random 32-byte `deviceAuthToken` minted at pairing (or at vault creation for the first device). The relay tracks the list of valid tokens per vault. Every relay request carries the token in `Authorization: Bearer`. Revoking deletes the token at the relay; the revoked device can no longer sync, though events it already pulled remain on disk. Real revocation, not theater.

**Event AAD** includes `vaultId || deviceId || clientNonce`, where `clientNonce` is a 16-byte cryptographically random value chosen by the client per event and carried in cleartext on the envelope. A malicious or buggy relay can't silently swap or replay ciphertext blobs without devices noticing — AEAD verification fails on tampered AAD — and the relay enforces per-vault `(deviceId, clientNonce)` uniqueness as a second line of defense against replay. See **ADR-0006** for the full rationale; this supersedes an earlier draft of this line that read `vaultId || deviceId || sequenceNumber`, which couldn't work because the relay assigns `seq` _after_ the client encrypts (ADR-0002).

**Libraries:**

- `libsodium-wrappers-sumo` — TS core, Cloudflare Worker, Chrome + Safari extensions
- `react-native-libsodium` (serenity-kit) — RN/Expo iOS, JSI-based, API-compatible with the JS package
- `dryoc` — Tauri/Rust desktop (avoid the deprecated `sodiumoxide`)
- `@scure/bip39` (TS) + `bip39` crate (Rust) for mnemonic encoding

## Considered and rejected

- **Noise Protocol Framework.** Wrong tool — Noise is a session/transport protocol; defer needs at-rest blob encryption that any future device with the vault key must decrypt. Noise even just for pairing is unnecessary: the QR is a one-way OOB channel that already carries authenticity; Noise solves the _opposite_ problem (active MITM on a bidirectional channel with no pre-shared secret).
- **Per-device keypairs with envelope encryption (Signal/Matrix shape).** Overkill for single-user read-later. Cryptographic revocation still doesn't help with past events the device already pulled, so the practical revocation outcome is identical to the relay-token approach with vastly more crypto complexity.
- **age / OpenPGP.** No good RN binding; file-oriented framing adds overhead per blob; X25519 wrapping isn't needed for single-user.
- **Argon2id KDF over the recovery mnemonic.** A 24-word BIP-39 mnemonic carries 256 bits of entropy by construction; KDF stretching is ceremony, not security. If a passphrase recovery option is added later, the KDF layer goes in then.

## Consequences

- The threat model is honest: an attacker who steals a device gets historical events. Real revocation requires either rotating the vault key (heavyweight; deferred) or accepting that past data on the lost device is gone.
- Recovery is mnemonic-only. There is no server-side reset; defer cannot help a user who loses their mnemonic and all their paired devices.
