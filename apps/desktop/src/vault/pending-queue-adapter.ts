import type {
  PendingEventQueueEntry,
  StoragePort as QueueStoragePort,
} from "@defer/core/pending-event-queue";

import type { StoragePort } from "../storage/index.js";
import { bytesToBase64Url, base64UrlToBytes } from "../util/base64.js";

const SETTING_KEY = "pendingEventQueue";

type SerializedEntry = Omit<PendingEventQueueEntry, "event"> & { eventBase64Url: string };

/**
 * Backs `@defer/core`'s `PendingEventQueue` with the desktop's `settings`
 * table. The queue itself is the engine; this adapter only translates
 * `Uint8Array` payloads to/from the base64url-string stored alongside the
 * other settings rows. Slice #52 may swap this for a dedicated table once
 * search wants to query queue size cheaply.
 */
export class SqlitePendingQueueStorage implements QueueStoragePort {
  readonly #storage: StoragePort;

  constructor(storage: StoragePort) {
    this.#storage = storage;
  }

  async read(): Promise<PendingEventQueueEntry[]> {
    const raw = await this.#storage.getSetting(SETTING_KEY);
    if (raw === undefined) return [];
    const parsed = JSON.parse(raw) as SerializedEntry[];
    return parsed.map((entry) => ({
      id: entry.id,
      event: base64UrlToBytes(entry.eventBase64Url),
      enqueuedAt: entry.enqueuedAt,
      attemptCount: entry.attemptCount,
      lastAttemptAt: entry.lastAttemptAt,
      status: entry.status,
    }));
  }

  async write(events: PendingEventQueueEntry[]): Promise<void> {
    const serialized: SerializedEntry[] = events.map((entry) => ({
      id: entry.id,
      eventBase64Url: bytesToBase64Url(entry.event),
      enqueuedAt: entry.enqueuedAt,
      attemptCount: entry.attemptCount,
      lastAttemptAt: entry.lastAttemptAt,
      status: entry.status,
    }));
    await this.#storage.setSetting(SETTING_KEY, JSON.stringify(serialized));
  }
}
