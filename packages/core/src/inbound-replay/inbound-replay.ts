import { EventSchema, type Event } from "../events/index.js";
import type { RelayClient } from "../relay-client/index.js";

export type InboundReplayDeps = {
  client: RelayClient;
  /**
   * Cursor source — returns the current `since` value (the highest applied
   * `seq`, or 0 for a fresh install / restore).
   */
  readCursor: () => Promise<number>;
  /**
   * Cursor sink — persists the new `since` value after a batch applies.
   * Atomicity invariant: the cursor MUST advance only after every event
   * in the batch has been applied + persisted by `onEvent`. A crash
   * between writes leaves the cursor on the old value and the next pull
   * re-fetches the unacknowledged tail (idempotent through the projection
   * reducer per ADR-0002 §"replay-safe").
   */
  writeCursor: (since: number) => Promise<void>;
  /**
   * Applies one event to the projection + persists it to local storage.
   * Throwing aborts the pull — the cursor is not advanced and the event
   * will be re-fetched on the next call. Returning resolves to "applied,
   * safe to advance cursor past this seq."
   */
  onEvent: (event: Event) => Promise<void>;
  /**
   * Optional hook the host wires to surface "we hit a bad event and
   * skipped it" diagnostics without aborting the pull. Useful for
   * telemetry: a malformed event from the relay is rare in practice
   * but worth knowing about.
   */
  onSkipped?: (reason: "schema" | "unknown-type", rawEvent: unknown) => void;
};

export type ReplayResult = {
  /** Count of events successfully applied this call (across all pages). */
  applied: number;
  /** Count of events the relay returned that we couldn't apply. */
  skipped: number;
  /** Highest `seq` the cursor advanced to during this call. */
  cursor: number;
};

/**
 * Pulls events from the relay, applies them through the projection, and
 * advances a persistent cursor — the engine behind PRD US #56–58 (pull on
 * open, periodic, manual refresh).
 *
 * Owns nothing it does not need to own: no timers, no UI affordances, no
 * HTTP. Triggers come from the host. The host wires `readCursor` /
 * `writeCursor` to its own storage and chooses `onEvent` semantics —
 * typically "persist to events table + apply via projection store" on a
 * sync participant.
 *
 * Paging: when `pullEvents` returns a non-null `nextSince` the loop
 * re-issues the request transparently until `nextSince === null`. The
 * cursor advances at the end of each page, so a crash mid-paging
 * preserves all already-applied events.
 */
export class InboundReplay {
  readonly #deps: InboundReplayDeps;

  constructor(deps: InboundReplayDeps) {
    this.#deps = deps;
  }

  async pull(): Promise<ReplayResult> {
    const { client, readCursor, writeCursor, onEvent, onSkipped } = this.#deps;
    let cursor = await readCursor();
    let applied = 0;
    let skipped = 0;

    for (;;) {
      const response = await client.pullEvents(cursor);
      if (response.events.length === 0) break;

      for (const raw of response.events) {
        const parsed = EventSchema.safeParse(raw);
        if (!parsed.success) {
          skipped += 1;
          onSkipped?.("schema", raw);
          // Schema-failing events shouldn't block forward progress —
          // advance past them so we don't get stuck in a loop. The
          // `seq` is on the raw payload (relay-side guarantee per
          // PullEventsResponseSchema) even if the rest fails our shape
          // check, so we read it back optimistically.
          if (
            typeof raw === "object" &&
            raw !== null &&
            "seq" in raw &&
            typeof (raw as { seq: unknown }).seq === "number"
          ) {
            cursor = Math.max(cursor, (raw as { seq: number }).seq);
          }
          continue;
        }
        const event = parsed.data;
        await onEvent(event);
        applied += 1;
        cursor = Math.max(cursor, event.seq);
      }

      // Persist the new cursor only after the whole page is applied.
      await writeCursor(cursor);

      if (response.nextSince === null) break;
      // The relay's `nextSince` is the last seq of the page — advance
      // past it for the next request so we don't re-fetch the same page.
      cursor = response.nextSince;
    }

    return { applied, skipped, cursor };
  }
}
