import { cloneEntries } from "./clone-entry.js";
import type { PendingEventQueueEntry, StoragePort } from "./index.js";

export class InMemoryStoragePort implements StoragePort {
  #entries: PendingEventQueueEntry[] = [];

  async read(): Promise<PendingEventQueueEntry[]> {
    return cloneEntries(this.#entries);
  }

  async write(events: PendingEventQueueEntry[]): Promise<void> {
    this.#entries = cloneEntries(events);
  }
}
