import type { PendingEventQueueEntry } from "./index.js";

export function cloneEntry(entry: PendingEventQueueEntry): PendingEventQueueEntry {
  return {
    id: entry.id,
    event: new Uint8Array(entry.event),
    enqueuedAt: entry.enqueuedAt,
    attemptCount: entry.attemptCount,
    lastAttemptAt: entry.lastAttemptAt,
    status: entry.status,
  };
}

export function cloneEntries(entries: readonly PendingEventQueueEntry[]): PendingEventQueueEntry[] {
  return entries.map(cloneEntry);
}
