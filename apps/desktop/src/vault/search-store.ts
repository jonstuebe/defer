import { SearchIndex } from "@defer/core/search-index";
import type { Event } from "@defer/core";

import type { StoragePort } from "../storage/index.js";

/**
 * Reactive wrapper around `@defer/core`'s `SearchIndex`. The index is
 * stateless across restarts in slice #52 — we rebuild it from the
 * events table on startup. (FTS5 will move maintenance into SQLite when
 * a sql.js build with the extension lands; until then the rebuild on
 * launch is cheap enough.)
 *
 * Listeners are notified when the index mutates so React can rerun
 * `search()` against the new state. The current query string isn't
 * stored here — `MainView` owns it and re-queries on every render with
 * the latest index snapshot.
 */
export class SearchStore {
  readonly #index = new SearchIndex();
  readonly #listeners = new Set<() => void>();
  #revision = 0;

  getIndex(): SearchIndex {
    return this.#index;
  }

  /**
   * Monotonic version counter — increments on every notify. `MainView`'s
   * `useMemo` reads this so React invalidates the search-filtered list
   * when the underlying index mutates.
   */
  getRevision(): number {
    return this.#revision;
  }

  /**
   * Rebuilds the index by replaying every persisted event. Called once
   * on app start, after the projection has hydrated.
   */
  async hydrate(storage: StoragePort): Promise<void> {
    const rows = await storage.allEvents();
    for (const row of rows) {
      try {
        const event = JSON.parse(row.payload) as Event;
        this.#index.apply(event);
      } catch {
        // Skip — the projection-store hydrate path already logs
        // malformed payload rows.
      }
    }
    this.#notify();
  }

  apply(event: Event): void {
    this.#index.apply(event);
    this.#notify();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}
