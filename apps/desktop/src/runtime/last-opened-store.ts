import type { StoragePort } from "../storage/index.js";

/**
 * Reactive cache around the device-local `lastOpenedAt` table.
 *
 * The table is local-only (per CONTEXT.md — read-state is NOT an event)
 * so the projection-store doesn't know about it. The UI subscribes here
 * to dim rows the user has already opened. State stays in memory after
 * the first hydrate; mutations write through to SQLite and refresh the
 * snapshot synchronously so React's `useSyncExternalStore` sees the new
 * map immediately.
 */
export class LastOpenedStore {
  readonly #storage: StoragePort;
  #snapshot: ReadonlyMap<string, number> = new Map();
  readonly #listeners = new Set<() => void>();
  #ready: Promise<void> | null = null;

  constructor(storage: StoragePort) {
    this.#storage = storage;
  }

  async hydrate(): Promise<void> {
    if (this.#ready !== null) return this.#ready;
    this.#ready = (async () => {
      this.#snapshot = await this.#storage.getLastOpenedTimestamps();
      this.#notify();
    })();
    return this.#ready;
  }

  getSnapshot(): ReadonlyMap<string, number> {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async markOpened(itemId: string, openedAt: number = Date.now()): Promise<void> {
    await this.#storage.markItemOpened(itemId, openedAt);
    const next = new Map(this.#snapshot);
    next.set(itemId, openedAt);
    this.#snapshot = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
