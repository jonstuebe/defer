# Vault deletion uses a 48-hour grace period, not credential gating

"Delete vault" is initiated from any signed-in device by typing the literal string `DEFER`. It does **not** require re-entering the 24-word recovery mnemonic. The deleting device signs a `VaultDeletionScheduled { scheduledFor: now + 48h, scheduledBy }` event with the vault key and emits it to the event log, plus calls `POST /vault/:id/schedule-deletion` on the relay with the same signed payload.

During the 48-hour window, all paired devices show a persistent banner ("Vault scheduled for deletion in 47:13:22 — Cancel"). Any paired device can emit a `VaultDeletionCancelled` event (also signed) to abort. After the window elapses, the relay's Durable Object alarm fires: it emits a final `VaultDeleted` event (signed with the vault key, payload from step 1 + relay-attached completion timestamp), calls `state.storage.deleteAll()`, and returns 410 to future requests.

**The signed `VaultDeleted` event in the event log is the only thing that triggers a client to wipe its local data.** Clients verify the signature against the vault key before wiping. A malicious relay returning 410 with no valid signed event cannot weaponize the wipe.

## Considered and rejected

- **Require re-entering the 24-word recovery mnemonic to delete.** Rejected as wrong friction: users recorded the mnemonic once at vault creation and likely cannot produce it months later. The gate would lock legitimate users out of deletion while doing nothing against an attacker who has the mnemonic (and therefore already has full read access).
- **HTTP 410 status code alone as the wipe trigger.** Rejected because it breaks the blind-relay promise: a compromised or malicious relay could send 410 to any device and silently destroy its local data. The wipe trigger must be authenticated end-to-end.
- **No vault-deletion flow at all in v1.** Rejected. "Your own dataset" loses meaning if there's no way to actually delete it from the relay. Users uncomfortable with data lingering on Cloudflare have no escape hatch.

## Consequences

- A stolen recovery mnemonic cannot silently nuke the vault. The 48-hour grace window plus the cross-device cancellation banner gives the legitimate user time to notice and cancel from any paired device.
- The relay must implement Durable Object alarms for the deletion timer, and a `POST /vault/:id/cancel-deletion` endpoint authenticated by any device's `deviceAuthToken`.
- Sign-out (per-device) is a separate flow and uses a `pendingRevocation` durable flag on the device to be crash-safe — the device writes the intent before any network call, retries on next launch if the call failed.
