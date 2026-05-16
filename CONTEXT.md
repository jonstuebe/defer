# Defer

A local-first **read-later queue** in the shape of Instapaper. Items flow through states (Inbox → Archive), with optional tags for topic organization. Each user owns their own dataset; devices sync end-to-end encrypted blobs through a blind relay.

## Language

### Vault concepts

**Vault**:
The user's complete collection of saved items, protected by a 32-byte vault key. The vault has an opaque vault ID (16 bytes) used as the relay's namespace; the vault ID is derived deterministically from the vault key via HKDF with a fixed salt, so the vault key alone is sufficient for recovery. The unit of "your own dataset."
_Avoid_: account, library, workspace

**Vault key**:
The 32-byte symmetric key that encrypts every event in a vault. Held only by paired devices; never seen by the relay.
_Avoid_: master key, encryption key, secret

**Recovery mnemonic**:
A 24-word BIP-39 phrase encoding the 32-byte vault key (with BIP-39 checksum). Shown once at vault creation; the user records it. Used to restore access on a brand-new device when no other device is available. The vault ID is not in the mnemonic — it's derived from the vault key on demand.
_Avoid_: backup, password, recovery file

### Item concepts

**Item**:
A single saved entry in a vault. In v1 this is URL + metadata only (no extracted article body).
_Avoid_: bookmark, article, link, page (all overloaded; pick one canonical word)

**State**:
The lifecycle position of an item in the read-later queue. Exactly one of: `Inbox`, `Archive`. `Liked` is an independent flag that can apply in either state.
_Avoid_: status, folder, category, bucket

**Tag**:
A user-defined topic label attached to an item. An item has zero or more tags. Used for topic organization, distinct from state.
_Avoid_: category, label, folder

### Sync concepts

**Event**:
The unit of synchronization. An immutable, append-only, self-contained record of a single change. Items emerge from replaying the event stream in `seq` order (relay-assigned). Every event carries the full data needed to apply it — no event implicitly references prior state.
_Avoid_: action, change, transaction, message

**Pending event**:
An **Event** that a **Device** has captured but not yet acknowledged by the **Relay**. Stored locally in a write-ahead queue so saves survive offline use, mid-flight crashes, and (on iOS) extension suspension. Flushed on the next available opportunity.
_Avoid_: queued event, draft, outbox item

The v1 event catalog (closed set; adding new types requires a protocol version bump):

- `ItemSaved { itemId, url, canonicalUrl, title, savedAt }` — creates a new item in Inbox, or "touches" an existing item with the same `canonicalUrl` (bumps `savedAt`, returns to Inbox if Archived)
- `ItemArchived { itemId }`
- `ItemUnarchived { itemId }`
- `ItemLiked { itemId }`
- `ItemUnliked { itemId }`
- `ItemTagged { itemId, tag }`
- `ItemUntagged { itemId, tag }`
- `ItemTitleEdited { itemId, title }`
- `ItemDeleted { itemId }` — hard delete; tombstone garbage-collected after a retention window
- `DeviceRegistered { deviceId, deviceName, deviceType, registeredAt }` — emitted by a new device on first sync after **Pairing**; appears in the Devices list across all paired devices
- `DeviceRevoked { deviceId }` — emitted when a device is revoked; the corresponding **Device auth token** is also deleted at the **Relay** via a separate authenticated API call. The revoked device's last act is to POST this event _before_ its token is deleted, with a durable `pendingRevocation` local flag to survive crashes
- `VaultDeletionScheduled { scheduledFor, scheduledBy }` — signed with the **Vault key**; any paired **Device** can initiate. Triggers a 48-hour grace window during which the deletion can be cancelled
- `VaultDeletionCancelled { cancelledBy }` — signed with the **Vault key**; emitted by any paired **Device** to abort an in-progress deletion within the grace window
- `VaultDeleted { deletedAt }` — signed with the **Vault key**; emitted by the **Relay**'s Durable Object alarm when the 48-hour window elapses. **This is the only event that triggers a client to wipe its local copy**; clients verify the signature against the vault key before wiping

Read-state ("have I opened this?") is **not** an event — it's a local-only `lastOpenedAt` per device, used for UI dimming. It does not sync.

### Device concepts

**Device**:
A client that participates in a vault. Identified by a stable `deviceId` (random 16 bytes), a user-given `deviceName`, and a `deviceAuthToken` (random 32 bytes) held by the device and tracked by the **Relay**. Two roles exist:

- **Sync participant** — holds a full local copy of the vault by pulling and replaying every **Event**. The mobile and desktop **Apps** play this role.
- **Thin sender** — never pulls events; only emits new ones. Holds at most a small local cache (e.g., recent tags it has used) for its own UX. The browser **Extensions** and iOS Share Extension play this role.
  _Avoid_: client, peer

**Device auth token**:
A random 32-byte secret minted for each **Device** during **Pairing** (or at vault creation for the first device). The **Relay** tracks the list of valid tokens per **Vault** and rejects requests that don't carry one. Revoking a device deletes its token — the device can no longer sync new events, though events it already pulled remain on disk.
_Avoid_: API key, session, password

**Pairing**:
The act of granting a new device access to an existing vault. The new device shows an ephemeral public key as a QR; an already-paired device seals the vault key to that public key and posts the ciphertext to the relay under a short-lived pairing token.
_Avoid_: linking, login, sign-in

### Service

**Relay**:
The transport/storage service that holds encrypted blobs and routes them between devices. Sees only opaque vault IDs and ciphertext — never URLs, titles, or content.
_Avoid_: server, backend, cloud

## Relationships

- A **Vault** contains zero or more **Items**, derived by replaying its **Events**
- A **Vault** is accessed by one or more **Devices** (via **Pairing**)
- A **Device** emits **Events** through the **Relay**; **Sync participants** also pull and replay them
- The **Relay** never sees plaintext **Event** content — only ciphertext keyed by **Vault** ID
- The **Vault key** encrypts every **Event**; the **Recovery mnemonic** encodes it for human-readable backup. The **Vault** ID is derived from the **Vault key** (deterministic HKDF), so the mnemonic alone recovers everything
- Outgoing **Events** are written to a local **Pending event** queue before being POSTed, so saves are durable across crashes and offline use
- An **Item** has exactly one **State** and zero or more **Tags**
- The sidebar in the app is organized as: fixed **States** (Inbox, Archive, Liked) at the top, then a list of **Tags** below
- Items are deduped by canonical URL. Saving a URL already in the **Vault** "touches" the existing **Item** (bumps `savedAt`, returns it to Inbox if it was in Archive) rather than creating a new one

## Example dialogue

> **Dev:** "When the user hits save in the Chrome extension, do we POST an event directly to the relay, or write it locally first?"
>
> **Architect:** "Always write to the local **Pending event** queue first — the extension is a **Thin sender** and that's the durability mechanism. The POST happens after. If the network fails, the extension retries on its next alarm."
>
> **Dev:** "OK. And when the desktop app pulls events back, does it have to do anything special with the events the extension emitted?"
>
> **Architect:** "No. All events look the same on the wire — `seq`, `type`, `data`. The desktop is a **Sync participant**, so it just replays. The fact that the source was a **Thin sender** is invisible after the **Event** lands at the **Relay**."
>
> **Dev:** "What if two devices save the same URL at the same time?"
>
> **Architect:** "Both emit `ItemSaved` events with the same `canonicalUrl`. The **Relay** assigns each one a monotonic `seq`. When devices replay, the first event creates the **Item**, the second event 'touches' it — bumps `savedAt`, returns to Inbox if it was in Archive. No conflict; the events are commutative."

## Flagged ambiguities

- "Category" was used by the user in early discussion; resolved to mean **State** + **Tag** (not folders, not hierarchical). The word "category" is now reserved — do not use it in the codebase or UI copy.
- The canonical name for a saved entry ("Item" vs "Bookmark" vs "Article") is provisional; user-facing copy may differ from the internal term.
