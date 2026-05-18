import { InboundReplay } from "@defer/core/inbound-replay";
import { RelayClient } from "@defer/core/relay-client";
import type { Event } from "@defer/core";

import type { StoragePort } from "../storage/index.js";
import type { VaultProjectionStore } from "./projection-store.js";
import type { SearchStore } from "./search-store.js";
import { executeVaultWipe, shouldRouteThroughWipe } from "./vault-wipe-executor.js";

export const SETTING_INBOUND_CURSOR = "sync.inboundCursor";

/**
 * Default pull-on-foreground cadence — matches PRD US #57 ("updates from
 * other devices show up within a minute or so"). The desktop schedules a
 * timer at this interval while the window has focus; backgrounded tabs
 * pause naturally. A manual refresh button (PRD US #58) bypasses the
 * timer at any time.
 */
export const DEFAULT_PULL_INTERVAL_MS = 60_000;

/**
 * Builds an `InboundReplay` wired to the desktop's storage + projection.
 *
 * Cursor lives in the settings table (single integer keyed by
 * `sync.inboundCursor`). Per-event handling: persist plaintext payload to
 * the events table (so a future restart can hydrate the projection from
 * the local log without re-pulling) and apply through the reactive store
 * so the UI updates immediately.
 *
 * Idempotency: applying the same event twice is safe — the reducer's
 * "touch" / "no-op" cases (ADR-0002 §"replay-safe") absorb the duplicate.
 * `appendEvent` uses `INSERT OR IGNORE` on `(deviceId, clientNonce)` so
 * the row write is also idempotent.
 */
export function makeInboundReplay(deps: {
  client: RelayClient;
  storage: StoragePort;
  projection: VaultProjectionStore;
  searchStore?: SearchStore;
  /**
   * Fires after a `VaultDeleted` event triggers a wipe. Hosts use this
   * to navigate back to the welcome screen and stop the inbound
   * scheduler (PRD US #14).
   */
  onVaultWiped?: (deletedAt: number) => void;
  /**
   * Fires when a `VaultDeleted` event is REFUSED — invalid signature
   * or wrong-device-id. The reducer skips the event; the host surfaces
   * a diagnostic so the user knows a hostile event was rejected
   * (PRD US #15).
   */
  onVaultWipeRefused?: (reason: "invalid-signature" | "wrong-device-id") => void;
}): InboundReplay {
  const { client, storage, projection, searchStore, onVaultWiped, onVaultWipeRefused } = deps;
  return new InboundReplay({
    client,
    async readCursor() {
      const raw = await storage.getSetting(SETTING_INBOUND_CURSOR);
      if (raw === undefined) return 0;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    },
    async writeCursor(since) {
      await storage.setSetting(SETTING_INBOUND_CURSOR, String(since));
    },
    async onEvent(event: Event) {
      // `VaultDeleted` routes through the wipe coordinator BEFORE
      // touching the projection — once the signature is verified and
      // local state is destroyed, applying it through the reducer is
      // moot.
      if (shouldRouteThroughWipe(event)) {
        const outcome = await executeVaultWipe(storage, event);
        if (outcome.kind === "wiped") {
          // Persist the event row last so the cursor can still advance
          // past this seq — otherwise the next pull would re-fetch it
          // and refuse-as-invalid (no vault key remaining to verify).
          // For the wiped case we instead let the projection see it so
          // its `isDeleted` flag flips and the UI knows.
          projection.apply(event);
          searchStore?.apply(event);
          onVaultWiped?.(outcome.deletedAt);
          return;
        }
        onVaultWipeRefused?.(outcome.reason);
        return;
      }

      await storage.appendEvent({
        seq: event.seq,
        type: event.type,
        deviceId: event.deviceId,
        clientNonce: event.clientNonce,
        timestamp: event.timestamp,
        payload: JSON.stringify(event),
      });
      projection.apply(event);
      searchStore?.apply(event);
    },
    onSkipped(reason, raw) {
      // eslint-disable-next-line no-console
      console.warn("[inbound] skipped event", reason, raw);
    },
  });
}

/**
 * Drives `InboundReplay.pull()` from the desktop's runtime triggers:
 * - on app open (immediate)
 * - on a recurring interval while the window has focus
 * - on demand via `triggerNow()` for the manual refresh affordance
 *
 * Concurrency: a pull-in-progress short-circuits subsequent triggers so
 * a flurry of focus events doesn't stack queued network round trips. The
 * trailing trigger fires after the in-flight pull resolves so we never
 * drop an explicit "refresh now" request.
 */
export class InboundScheduler {
  readonly #replay: InboundReplay;
  readonly #intervalMs: number;
  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #inflight: Promise<void> | null = null;
  #pendingTrailingTrigger = false;

  constructor(replay: InboundReplay, intervalMs: number = DEFAULT_PULL_INTERVAL_MS) {
    this.#replay = replay;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    this.triggerNow();
    if (this.#intervalHandle === null) {
      this.#intervalHandle = setInterval(() => this.triggerNow(), this.#intervalMs);
    }
  }

  stop(): void {
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  triggerNow(): void {
    if (this.#inflight !== null) {
      this.#pendingTrailingTrigger = true;
      return;
    }
    this.#inflight = this.#runOnce()
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("[inbound] pull failed", err);
      })
      .finally(() => {
        this.#inflight = null;
        if (this.#pendingTrailingTrigger) {
          this.#pendingTrailingTrigger = false;
          this.triggerNow();
        }
      });
  }

  async #runOnce(): Promise<void> {
    await this.#replay.pull();
  }
}
