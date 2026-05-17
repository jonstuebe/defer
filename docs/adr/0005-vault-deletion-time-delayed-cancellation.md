# Vault deletion uses a 48-hour grace period, not credential gating

"Delete vault" is initiated from any signed-in device by typing the literal string `DEFER`. It does **not** require re-entering the 24-word recovery mnemonic. The deleting device signs **two** events with the vault key — a `VaultDeletionScheduled { scheduledFor: now + 48h }` and a **pre-signed** `VaultDeleted { deletedAt: now + 48h }` (the relay can't sign on its own, see ADR-0001) — and calls `POST /vault/:id/schedule-deletion` on the relay carrying both signed payloads in one request body. The relay persists the `VaultDeletionScheduled` event into the log immediately and stashes the pre-signed `VaultDeleted` blob in DO storage to be re-emitted verbatim when the alarm fires. The emitting device is identified by the event envelope's `deviceId`, so the event payload itself only carries `scheduledFor` / `deletedAt`.

**`VaultDeleted.deletedAt` MUST equal `VaultDeletionScheduled.scheduledFor`** — the relay does not attach a completion timestamp, because the relay never holds the vault key and so cannot sign over a fresh `deletedAt`. See ADR-0006 for the canonical-signed-bytes rule and the full `schedule-deletion` request body shape.

During the 48-hour window, all paired devices show a persistent banner ("Vault scheduled for deletion in 47:13:22 — Cancel"). Any paired device can emit a `VaultDeletionCancelled` event (also signed) to abort; cancellation also causes the relay to delete the stored pre-signed `VaultDeleted` blob, so it cannot be replayed if the same vault is later re-scheduled. After the window elapses without cancellation, the relay's Durable Object alarm fires: it reads the stored pre-signed `VaultDeleted` blob, assigns the next `seq`, emits it as the final event in the log, calls `state.storage.deleteAll()`, and returns 410 to future requests.

**The signed `VaultDeleted` event in the event log is the only thing that triggers a client to wipe its local data.** Clients verify the signature against the vault key before wiping. A malicious relay returning 410 with no valid signed event cannot weaponize the wipe.

## Considered and rejected

- **Require re-entering the 24-word recovery mnemonic to delete.** Rejected as wrong friction: users recorded the mnemonic once at vault creation and likely cannot produce it months later. The gate would lock legitimate users out of deletion while doing nothing against an attacker who has the mnemonic (and therefore already has full read access).
- **HTTP 410 status code alone as the wipe trigger.** Rejected because it breaks the blind-relay promise: a compromised or malicious relay could send 410 to any device and silently destroy its local data. The wipe trigger must be authenticated end-to-end.
- **No vault-deletion flow at all in v1.** Rejected. "Your own dataset" loses meaning if there's no way to actually delete it from the relay. Users uncomfortable with data lingering on Cloudflare have no escape hatch.

## Consequences

- A stolen recovery mnemonic cannot silently nuke the vault. The 48-hour grace window plus the cross-device cancellation banner gives the legitimate user time to notice and cancel from any paired device.
- The relay must implement Durable Object alarms for the deletion timer, and a `POST /vault/:id/cancel-deletion` endpoint authenticated by any device's `deviceAuthToken`.
- Sign-out (per-device) is a separate flow and uses a `pendingRevocation` durable flag on the device to be crash-safe — the device writes the intent before any network call, retries on next launch if the call failed.
