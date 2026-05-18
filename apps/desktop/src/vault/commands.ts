import { canonicalize } from "@defer/core/canonicalize";
import {
  PendingEventSchema,
  PendingItemSavedSchema,
  type Event,
  type PendingEvent,
} from "@defer/core";
import { PendingEventQueue } from "@defer/core/pending-event-queue";

import type { StoragePort } from "../storage/index.js";
import type { VaultProjectionStore } from "./projection-store.js";
import type { SearchStore } from "./search-store.js";
import { randomClientNonceBase64Url } from "../util/base64.js";
import { generateItemId } from "../util/random-item-id.js";
import { encodePendingEvent } from "./wire-codec.js";

export type VaultCommandsDeps = {
  storage: StoragePort;
  projection: VaultProjectionStore;
  pendingQueue: PendingEventQueue;
  deviceId: string;
  now: () => number;
  /**
   * Optional search index updated alongside the projection. When set,
   * locally-emitted events feed both stores so the search bar reflects
   * an item the user just saved without waiting for a hydrate.
   */
  searchStore?: SearchStore;
  /**
   * Fire-and-forget trigger invoked after each command so events flush in
   * the background. The desktop wires this to `OutboundFlush.flush()`. The
   * return type is `void` (not `Promise<void>`) deliberately — commands
   * resolve as soon as the local state is durable, never blocking the UI
   * on a flaky network. Errors inside the flush are surfaced through the
   * host's own logging/toast pipeline.
   */
  onPersisted?: () => void;
};

/**
 * The named-action API the UI calls. Each command builds the corresponding
 * `@defer/core` event, projects it locally, persists the plaintext envelope
 * to the desktop's `events` table, and enqueues the wire-shaped bytes onto
 * the pending-event queue.
 *
 * All commands share the same path: validate the pending envelope, apply
 * to the projection, persist to the events table (with `seq=NULL` until
 * the relay acks), persist the resulting `Item` row, enqueue for outbound
 * flush, and signal `onPersisted`. The private `#emit` helper owns that
 * sequence so the public commands stay readable.
 */
export class VaultCommands {
  readonly #deps: VaultCommandsDeps;

  constructor(deps: VaultCommandsDeps) {
    this.#deps = deps;
  }

  async save(rawUrl: string, opts: { title?: string; savedAt?: number } = {}): Promise<void> {
    const canonicalUrl = canonicalize(rawUrl);
    const timestamp = this.#deps.now();
    const savedAt = opts.savedAt ?? timestamp;
    const itemId = generateItemId();
    const pendingEvent = {
      type: "ItemSaved" as const,
      deviceId: this.#deps.deviceId,
      timestamp,
      clientNonce: randomClientNonceBase64Url(),
      data: {
        itemId,
        url: rawUrl,
        canonicalUrl,
        title: opts.title ?? "",
        savedAt,
      },
    };
    // Save needs schema validation at the boundary because its `data`
    // payload is user-supplied (URL, title) — every other command's data
    // comes from already-stored projection state, so per-event validation
    // would be redundant. We still validate the envelope via `#emit`.
    PendingItemSavedSchema.parse(pendingEvent);
    await this.#emit(pendingEvent, [itemId]);
  }

  async archive(itemId: string): Promise<void> {
    await this.#emit(
      {
        type: "ItemArchived",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId },
      },
      [itemId],
    );
  }

  async unarchive(itemId: string): Promise<void> {
    await this.#emit(
      {
        type: "ItemUnarchived",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId },
      },
      [itemId],
    );
  }

  async like(itemId: string): Promise<void> {
    await this.#emit(
      {
        type: "ItemLiked",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId },
      },
      [itemId],
    );
  }

  async unlike(itemId: string): Promise<void> {
    await this.#emit(
      {
        type: "ItemUnliked",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId },
      },
      [itemId],
    );
  }

  async editTitle(itemId: string, title: string): Promise<void> {
    await this.#emit(
      {
        type: "ItemTitleEdited",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId, title },
      },
      [itemId],
    );
  }

  async tag(itemId: string, tag: string): Promise<void> {
    const normalized = tag.trim();
    if (normalized === "") throw new RangeError("VaultCommands.tag: tag must be non-empty");
    await this.#emit(
      {
        type: "ItemTagged",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId, tag: normalized },
      },
      [itemId],
    );
  }

  async untag(itemId: string, tag: string): Promise<void> {
    await this.#emit(
      {
        type: "ItemUntagged",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId, tag },
      },
      [itemId],
    );
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.#emit(
      {
        type: "ItemDeleted",
        deviceId: this.#deps.deviceId,
        timestamp: this.#deps.now(),
        clientNonce: randomClientNonceBase64Url(),
        data: { itemId },
      },
      [itemId],
    );
  }

  /**
   * Common emit pipeline shared by every command above.
   *
   * `affectedItemIds` is the set of item rows that may have changed shape
   * after applying this event — we re-read them from the projection and
   * persist the resulting rows so the items table stays consistent with
   * the reducer's output. `ItemDeleted` sets `deletedAt`; subsequent
   * `allItems()` reads exclude soft-deleted rows.
   */
  async #emit(pendingEvent: PendingEvent, affectedItemIds: readonly string[]): Promise<void> {
    // Envelope shape check — defends against a future caller (or an
    // accidental TS-loose cast) that constructs a malformed event. The
    // reducer downstream assumes the discriminated union is well-formed.
    PendingEventSchema.parse(pendingEvent);

    // Synthetic seq=0 envelope; the reducer never reads `seq`. The real
    // seq is stamped by `outboundFlush`'s onSeqAssigned (slice #46).
    const localEvent = { ...pendingEvent, seq: 0 } as Event;
    this.#deps.projection.apply(localEvent);
    this.#deps.searchStore?.apply(localEvent);

    await this.#deps.storage.appendEvent({
      seq: null,
      type: pendingEvent.type,
      deviceId: pendingEvent.deviceId,
      clientNonce: pendingEvent.clientNonce,
      timestamp: pendingEvent.timestamp,
      payload: JSON.stringify(pendingEvent),
    });

    const state = this.#deps.projection.getState();
    for (const id of affectedItemIds) {
      const item = state.items.get(id);
      if (item) await this.#deps.storage.putItem(item);
    }

    await this.#deps.pendingQueue.enqueue(encodePendingEvent(pendingEvent));
    this.#deps.onPersisted?.();
  }
}
