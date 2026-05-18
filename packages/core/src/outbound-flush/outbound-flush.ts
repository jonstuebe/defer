import { PendingEventSchema, type PendingEvent } from "../events/index.js";
import { MAX_BATCH_SIZE } from "../relay-protocol/index.js";
import { RelayError, type RelayClient } from "../relay-client/index.js";
import type { PendingEventQueue, PendingEventQueueEntry } from "../pending-event-queue/index.js";

export type SeqAssignment = {
  /** Envelope `clientNonce` of the locally-emitted event. */
  clientNonce: string;
  /** Envelope `deviceId` of the locally-emitted event. */
  deviceId: string;
  /** Relay-assigned monotonic per-vault `seq`. */
  seq: number;
};

export type OutboundFlushDeps = {
  queue: PendingEventQueue;
  client: RelayClient;
  /**
   * Called once per successful POST batch. The host wires this to update its
   * local events table so the projection's "synced vs pending" view stays
   * coherent. The assignments are in the same order as the request — index
   * `i` corresponds to the i-th event in the batch.
   */
  onSeqAssigned: (assignments: SeqAssignment[]) => Promise<void>;
  /**
   * Decodes a queue entry's bytes into a `PendingEvent`. The desktop wire
   * format today is UTF-8 JSON of the envelope (slice #45 / #46). A later
   * slice may swap this for an AEAD-encrypted bundle once the relay's wire
   * format settles on ciphertext; this hook keeps the queue's bytes opaque
   * to `OutboundFlush`.
   */
  decode: (bytes: Uint8Array) => PendingEvent;
};

export type FlushResult = {
  /** Count of events the relay acknowledged this call. */
  flushed: number;
  /** Count of events that failed mid-batch (kept on the queue for retry). */
  failed: number;
  /** Count of events the relay rejected as duplicates (kept off the queue). */
  duplicates: number;
};

/**
 * Drains the pending-event queue into the relay one batch at a time.
 *
 * Concurrency: a single `flush()` call drains until either the queue is
 * empty or a batch fails. The caller (UI save handler, periodic timer, etc.)
 * decides when to invoke; back-to-back invocations are safe because the
 * underlying `PendingEventQueue` serialises mutations on a write chain.
 *
 * Retry semantics: on `RelayError(DUPLICATE_CLIENT_NONCE)` we treat the
 * affected event as already-acked and mark it synced (the relay's
 * uniqueness contract per ADR-0006 §4.2 means the duplicate was committed
 * server-side before our retry). On any other relay or transport error we
 * mark the in-flight batch failed and stop draining — the queue's
 * `attemptCount` advances so the host can back off.
 */
export class OutboundFlush {
  readonly #queue: PendingEventQueue;
  readonly #client: RelayClient;
  readonly #onSeqAssigned: OutboundFlushDeps["onSeqAssigned"];
  readonly #decode: OutboundFlushDeps["decode"];

  constructor(deps: OutboundFlushDeps) {
    this.#queue = deps.queue;
    this.#client = deps.client;
    this.#onSeqAssigned = deps.onSeqAssigned;
    this.#decode = deps.decode;
  }

  async flush(): Promise<FlushResult> {
    let flushed = 0;
    let failed = 0;
    let duplicates = 0;

    // Drain loop: each iteration processes at most MAX_BATCH_SIZE events. A
    // failed batch breaks the loop so the host can decide retry timing.
    for (;;) {
      const batch = await this.#queue.peek(MAX_BATCH_SIZE);
      if (batch.length === 0) break;

      const { events, decoded } = this.#decodeBatch(batch);
      if (events.length === 0) {
        // Every entry in this batch was undecodable — they'd never succeed
        // on the wire, so mark them failed once to advance attemptCount.
        await this.#queue.markFailed(batch.map((e) => e.id));
        failed += batch.length;
        break;
      }

      const ids = decoded.map(({ entry }) => entry.id);
      await this.#queue.markInFlight(ids);

      try {
        const response = await this.#client.pushEvents(events);
        const assignments: SeqAssignment[] = decoded.map(({ event }, index) => {
          const seq = response.assigned[index];
          if (seq === undefined) {
            // Defensive: PushEventsRequestSchema enforces same-length arrays
            // on the relay side, so this branch is effectively dead. Surface
            // as a typed assignment shortfall rather than crash silently.
            throw new Error(
              `relay returned ${response.assigned.length} seqs for ${events.length} events`,
            );
          }
          return { clientNonce: event.clientNonce, deviceId: event.deviceId, seq };
        });
        await this.#onSeqAssigned(assignments);
        await this.#queue.markSynced(ids);
        flushed += events.length;
      } catch (err) {
        if (err instanceof RelayError && err.code === "DUPLICATE_CLIENT_NONCE") {
          // The relay already has these events (likely retry after a
          // network failure). Drop them from the queue — they're committed.
          await this.#queue.markSynced(ids);
          duplicates += events.length;
          continue;
        }
        await this.#queue.markFailed(ids);
        failed += events.length;
        throw err;
      }
    }

    return { flushed, failed, duplicates };
  }

  #decodeBatch(batch: PendingEventQueueEntry[]): {
    events: PendingEvent[];
    decoded: Array<{ entry: PendingEventQueueEntry; event: PendingEvent }>;
  } {
    const events: PendingEvent[] = [];
    const decoded: Array<{ entry: PendingEventQueueEntry; event: PendingEvent }> = [];
    for (const entry of batch) {
      let event: PendingEvent;
      try {
        event = this.#decode(entry.event);
      } catch {
        // A queue entry that doesn't decode under our wire shape is a
        // corruption we can't transmit. Leave it in the batch's `failed`
        // outcome at the caller's `markFailed` line so its attemptCount
        // advances; downstream the host can surface a "this event is
        // stuck" diagnostic.
        continue;
      }
      const parsed = PendingEventSchema.safeParse(event);
      if (!parsed.success) continue;
      events.push(parsed.data);
      decoded.push({ entry, event: parsed.data });
    }
    return { events, decoded };
  }
}
