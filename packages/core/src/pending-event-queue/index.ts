// Entry type is `PendingEventQueueEntry` (not `PendingEvent`) to avoid colliding
// with the `PendingEvent` catalog type exported from `../events/index.js`.

export type PendingEventQueueEntryStatus = "pending" | "in-flight" | "failed";

export type PendingEventQueueEntry = {
  id: string;
  event: Uint8Array;
  enqueuedAt: number;
  attemptCount: number;
  lastAttemptAt: number | null;
  status: PendingEventQueueEntryStatus;
};

export interface StoragePort {
  read(): Promise<PendingEventQueueEntry[]>;
  write(events: PendingEventQueueEntry[]): Promise<void>;
}

export { InMemoryStoragePort, createInMemoryStorage } from "./in-memory-storage.js";

function cloneEntry(entry: PendingEventQueueEntry): PendingEventQueueEntry {
  return {
    id: entry.id,
    event: new Uint8Array(entry.event),
    enqueuedAt: entry.enqueuedAt,
    attemptCount: entry.attemptCount,
    lastAttemptAt: entry.lastAttemptAt,
    status: entry.status,
  };
}

function cloneEntries(entries: readonly PendingEventQueueEntry[]): PendingEventQueueEntry[] {
  return entries.map(cloneEntry);
}

export class PendingEventQueue {
  readonly #storage: StoragePort;
  #entries: PendingEventQueueEntry[] = [];
  #ready: Promise<void> | null = null;

  constructor(storage: StoragePort) {
    this.#storage = storage;
  }

  // Crash recovery: any `in-flight` entries from a prior session are reset to
  // `pending` on first access. Simpler than a stale-timeout and adequate here.
  async #ensureReady(): Promise<void> {
    if (this.#ready === null) {
      this.#ready = this.#hydrate();
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

  async enqueue(encryptedEvent: Uint8Array): Promise<PendingEventQueueEntry> {
    await this.#ensureReady();
    const entry: PendingEventQueueEntry = {
      id: crypto.randomUUID(),
      event: new Uint8Array(encryptedEvent),
      enqueuedAt: Date.now(),
      attemptCount: 0,
      lastAttemptAt: null,
      status: "pending",
    };
    this.#entries.push(entry);
    await this.#persist();
    return cloneEntry(entry);
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
  }

  async markSynced(ids: string[]): Promise<void> {
    await this.#ensureReady();
    const idSet = new Set(ids);
    const next = this.#entries.filter((entry) => !idSet.has(entry.id));
    if (next.length !== this.#entries.length) {
      this.#entries = next;
      await this.#persist();
    }
  }

  async markFailed(ids: string[]): Promise<void> {
    await this.#ensureReady();
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
  }

  // Total entries across all statuses, not just pending/failed.
  async size(): Promise<number> {
    await this.#ensureReady();
    return this.#entries.length;
  }
}
