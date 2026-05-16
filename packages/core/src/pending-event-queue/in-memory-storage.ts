import type { PendingEventQueueEntry, StoragePort } from "./index.js";

function deepCopyEntries(entries: readonly PendingEventQueueEntry[]): PendingEventQueueEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    event: new Uint8Array(entry.event),
    enqueuedAt: entry.enqueuedAt,
    attemptCount: entry.attemptCount,
    lastAttemptAt: entry.lastAttemptAt,
    status: entry.status,
  }));
}

export class InMemoryStoragePort implements StoragePort {
  #entries: PendingEventQueueEntry[] = [];

  async read(): Promise<PendingEventQueueEntry[]> {
    return deepCopyEntries(this.#entries);
  }

  async write(events: PendingEventQueueEntry[]): Promise<void> {
    this.#entries = deepCopyEntries(events);
  }
}

export function createInMemoryStorage(): InMemoryStoragePort {
  return new InMemoryStoragePort();
}
