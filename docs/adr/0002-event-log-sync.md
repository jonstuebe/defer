# Append-only event log for sync

Sync uses a per-vault append-only event log (`ItemSaved`, `ItemArchived`, `ItemTagged`, etc.) rather than current-state CRUD or a CRDT-based store. Each event is **self-contained** — it carries all the data needed to apply it; no event implicitly references prior state. The relay assigns a monotonic `seq` per vault on arrival, which is the only ordering mechanism clients depend on. Items emerge from replaying the log in `seq` order.

The log is append-only forever in v1. No snapshots, no compaction. For realistic usage (~10K events over 5 years × ~500 bytes each), new-device first-sync stays under 10MB and replays in a second or two. Snapshot compaction is a deferred v2 feature; the event format is deliberately designed so it can be added later without protocol breakage.

## Considered alternatives

- **Current-state snapshots with per-field LWW.** Rejected: requires careful tombstone management for deletions, concurrent edits to the same item need field-level merge logic, and harder to debug when state drifts. The event-log shape is no harder to write and is dramatically easier to reason about.
- **Full CRDT (Yjs / Automerge).** Rejected: massive overkill for a data model whose mutation surface is `{save, archive, like, tag, edit-title, delete}`. Library lock-in and complexity tax on every read path.

## Consequences

- Conflicts mostly self-resolve: same-URL saves from two devices both apply (the second becomes a "touch"); tag add/remove are commutative; state changes resolve by `seq` order.
- The event format is **immutable**. To evolve a field, introduce a new event type (e.g., `ItemSavedV2`). Renaming or removing existing fields is forbidden.
- Old clients silently skip unknown event types. They later replay the same log after upgrading and pick up what they missed.
