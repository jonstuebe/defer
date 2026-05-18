import { apply, initialVaultState, type Event, type Item, type VaultState } from "@defer/core";

import type { StoragePort, StoredEventRow } from "../storage/index.js";

export type Unsubscribe = () => void;

/**
 * Reactive read model the UI subscribes to.
 *
 * Wraps `@defer/core`'s pure `apply(state, event)` reducer with a
 * subscribe/notify store. Mutating the projection is internal — the public
 * API is `apply(event)`, `getState()`, and `subscribe(listener)`. There is
 * no setter; the reducer is the only path that produces new state.
 *
 * `hydrate(...)` rebuilds state from the events table on startup; afterwards
 * `apply(event)` is the steady-state mutation called by `vaultCommands` and
 * (in slice #47) by `inboundReplay`.
 */
export class VaultProjectionStore {
  #state: VaultState = initialVaultState();
  readonly #listeners = new Set<() => void>();
  readonly #storage: StoragePort;

  constructor(storage: StoragePort) {
    this.#storage = storage;
  }

  getState(): VaultState {
    return this.#state;
  }

  getItemsSortedBySavedAtDesc(): Item[] {
    return [...this.#state.items.values()]
      .filter((item) => item.deletedAt === null)
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  apply(event: Event): void {
    const next = apply(this.#state, event);
    if (next === this.#state) return;
    this.#state = next;
    this.#notify();
  }

  async hydrate(): Promise<void> {
    const rows = await this.#storage.allEvents();
    let next = initialVaultState();
    for (const row of rows) {
      const event = decodeStoredEvent(row);
      if (!event) continue;
      next = apply(next, event);
    }
    this.#state = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

function decodeStoredEvent(row: StoredEventRow): Event | null {
  try {
    const parsed = JSON.parse(row.payload) as Event;
    return parsed;
  } catch {
    // A malformed payload is logged at the boundary that wrote it; the
    // reducer treats it as if it never arrived.
    return null;
  }
}
