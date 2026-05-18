import { canonicalize } from "@defer/core/canonicalize";
import { PendingItemSavedSchema, type Event } from "@defer/core";
import { PendingEventQueue } from "@defer/core/pending-event-queue";

import type { StoragePort } from "../storage/index.js";
import type { VaultProjectionStore } from "./projection-store.js";
import { randomClientNonceBase64Url } from "../util/base64.js";
import { generateItemId } from "../util/random-item-id.js";

export type VaultCommandsDeps = {
  storage: StoragePort;
  projection: VaultProjectionStore;
  pendingQueue: PendingEventQueue;
  deviceId: string;
  now: () => number;
};

/**
 * The named-action API the UI calls. Each command builds the corresponding
 * `@defer/core` event, projects it locally, persists the plaintext envelope
 * to the desktop's `events` table, and enqueues the wire-shaped bytes onto
 * the pending-event queue. The queue itself is not flushed in slice #45 —
 * `outboundFlush` lands in slice #46.
 */
export class VaultCommands {
  readonly #deps: VaultCommandsDeps;

  constructor(deps: VaultCommandsDeps) {
    this.#deps = deps;
  }

  async save(rawUrl: string, opts: { title?: string; savedAt?: number } = {}): Promise<void> {
    const { storage, projection, pendingQueue, deviceId, now } = this.#deps;
    const canonicalUrl = canonicalize(rawUrl);
    const timestamp = now();
    const savedAt = opts.savedAt ?? timestamp;
    const itemId = generateItemId();
    const clientNonce = randomClientNonceBase64Url();
    const title = opts.title ?? "";

    const pendingEvent = {
      type: "ItemSaved" as const,
      deviceId,
      timestamp,
      clientNonce,
      data: {
        itemId,
        url: rawUrl,
        canonicalUrl,
        title,
        savedAt,
      },
    };

    // Validate at the boundary so a malformed save never enters the queue.
    PendingItemSavedSchema.parse(pendingEvent);

    // Local projection uses a synthetic seq=0 envelope — the reducer never
    // reads `seq`, so the value is irrelevant for state. The real `seq`
    // arrives in slice #46 when the relay acks and we overwrite the row.
    const localEvent = { ...pendingEvent, seq: 0 } as Event;

    projection.apply(localEvent);

    await storage.appendEvent({
      seq: null,
      type: pendingEvent.type,
      deviceId: pendingEvent.deviceId,
      clientNonce: pendingEvent.clientNonce,
      timestamp: pendingEvent.timestamp,
      payload: JSON.stringify(pendingEvent),
    });

    // Persist the resulting Item row so the read model survives restart
    // without a full event replay. (Replay is still the source of truth on
    // `hydrate`; this is a caching write that keeps page-load fast.)
    const item = projection.getState().items.get(itemId);
    if (item) await storage.putItem(item);

    // Wire format for the queue is UTF-8 JSON of the PendingEvent envelope.
    // Slice #46 may swap this for an AEAD-encrypted bundle once the relay's
    // wire format settles on a ciphertext shape (currently still plaintext
    // PendingEvent per tests/e2e). The queue itself is content-opaque.
    const bytes = new TextEncoder().encode(JSON.stringify(pendingEvent));
    await pendingQueue.enqueue(bytes);
  }
}
