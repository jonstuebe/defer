// Entry type is `PendingEventQueueEntry` (not `PendingEvent`) to avoid colliding
// with the `PendingEvent` catalog type exported from `../events/index.js`.

import { cloneEntry, cloneEntries } from "./clone-entry.js";

export type PendingEventQueueEntryStatus = "pending" | "in-flight" | "failed";

export type PendingEventQueueEntry = {
  id: string;
  event: Uint8Array;
  enqueuedAt: number;
  attemptCount: number;
  lastAttemptAt: number | null;
  status: PendingEventQueueEntryStatus;
};

/**
 * Persistence port for the pending-event queue.
 *
 * Implementations must round-trip `Uint8Array` bytes faithfully — naïve
 * `JSON.stringify(entries)` loses the typed-array shape (it serialises as an
 * indexed object), and `JSON.parse` won't restore it. File and IndexedDB
 * adapters should encode the bytes explicitly (e.g. base64 for JSON-backed
 * stores, or store the buffer directly in IndexedDB which preserves it).
 */
export interface StoragePort {
  read(): Promise<PendingEventQueueEntry[]>;
  write(events: PendingEventQueueEntry[]): Promise<void>;
}

export { InMemoryStoragePort } from "./in-memory-storage.js";

export class PendingEventQueue {
  readonly #storage: StoragePort;
  #entries: PendingEventQueueEntry[] = [];
  #ready: Promise<void> | null = null;
  // Serialises mutating operations so concurrent callers issue
  // `storage.write(...)` calls in a deterministic order. Real backends (FS,
  // IndexedDB) do not guarantee write ordering, so we funnel every mutation
  // through this single promise chain.
  #writeChain: Promise<void> = Promise.resolve();

  constructor(storage: StoragePort) {
    this.#storage = storage;
  }

  // Crash recovery: any `in-flight` entries from a prior session are reset to
  // `pending` on first access. Simpler than a stale-timeout and adequate here.
  async #ensureReady(): Promise<void> {
    if (this.#ready === null) {
      this.#ready = this.#hydrate().catch((err) => {
        this.#ready = null;
        throw err;
      });
    }
    await this.#ready;
  }

  async #hydrate(): Promise<void> {
    const loaded = await this.#storage.read();
    let mutated = false;
    for (const entry of loaded) {
      if (entry.status === "in-flight") {
        entry.status = "pending";
        mutated = true;
      }
    }
    this.#entries = loaded;
    if (mutated) {
      await this.#persist();
    }
  }

  async #persist(): Promise<void> {
    await this.#storage.write(cloneEntries(this.#entries));
  }

  // Queue a mutation onto the write chain. The chain itself never rejects so
  // one failing op cannot poison subsequent ops; the original op's
  // success/failure is still propagated to its own caller via `next`.
  async #enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#writeChain.then(fn, fn);
    this.#writeChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async enqueue(encryptedEvent: Uint8Array): Promise<PendingEventQueueEntry> {
    await this.#ensureReady();
    // Snapshot input bytes before entering the chain so later mutations to
    // the caller's buffer cannot affect what we persist.
    const eventBytes = new Uint8Array(encryptedEvent);
    return this.#enqueueOp(async () => {
      const entry: PendingEventQueueEntry = {
        id: crypto.randomUUID(),
        event: eventBytes,
        enqueuedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: null,
        status: "pending",
      };
      this.#entries.push(entry);
      await this.#persist();
      return cloneEntry(entry);
    });
  }

  async peek(limit?: number): Promise<PendingEventQueueEntry[]> {
    await this.#ensureReady();
    const visible = this.#entries.filter(
      (entry) => entry.status === "pending" || entry.status === "failed",
    );
    const sliced = typeof limit === "number" ? visible.slice(0, limit) : visible;
    return cloneEntries(sliced);
  }

  async markInFlight(ids: string[]): Promise<void> {
    await this.#ensureReady();
    return this.#enqueueOp(async () => {
      const idSet = new Set(ids);
      const now = Date.now();
      let mutated = false;
      for (const entry of this.#entries) {
        if (idSet.has(entry.id)) {
          entry.status = "in-flight";
          entry.lastAttemptAt = now;
          mutated = true;
        }
      }
      if (mutated) {
        await this.#persist();
      }
    });
  }

  async markSynced(ids: string[]): Promise<void> {
    await this.#ensureReady();
    return this.#enqueueOp(async () => {
      const idSet = new Set(ids);
      const next = this.#entries.filter((entry) => !idSet.has(entry.id));
      if (next.length !== this.#entries.length) {
        this.#entries = next;
        await this.#persist();
      }
    });
  }

  async markFailed(ids: string[]): Promise<void> {
    await this.#ensureReady();
    return this.#enqueueOp(async () => {
      const idSet = new Set(ids);
      const now = Date.now();
      let mutated = false;
      for (const entry of this.#entries) {
        if (idSet.has(entry.id)) {
          entry.attemptCount += 1;
          entry.status = "failed";
          entry.lastAttemptAt = now;
          mutated = true;
        }
      }
      if (mutated) {
        await this.#persist();
      }
    });
  }

  /**
   * Total entries across all statuses (`pending`, `in-flight`, `failed`).
   *
   * Note: this does NOT equal `(await peek()).length`. `peek()` excludes
   * `in-flight` entries (they're owned by an in-progress flush). Callers who
   * want "things still owed to the relay" should use `(await peek()).length`
   * — this method is intended for telemetry and capacity checks.
   */
  async size(): Promise<number> {
    await this.#ensureReady();
    return this.#entries.length;
  }
}
