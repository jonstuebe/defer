import type { Event } from "../events/index.js";

export type SearchableField = "title" | "url";

export type SearchHit = {
  itemId: string;
  /** Number of distinct query tokens this item matched. Used as the score. */
  score: number;
};

/**
 * Local search index over the projection's items.
 *
 * v1 is a tokenized substring index implemented in pure JS — FTS5 in
 * sql.js's stock wasm build is unavailable (slice #45 docs the
 * deferral). When the desktop swaps to a sql.js build that includes
 * FTS5 (or tauri-plugin-sql), this module's public API stays the same;
 * only the internal storage changes.
 *
 * Tokenisation is intentionally simple: lowercase + split on
 * `[^a-z0-9]+`. This matches the spirit of FTS5's `porter unicode61`
 * tokeniser for ASCII text; non-ASCII is folded by `toLowerCase`. URLs
 * tokenise reasonably under this rule (hostnames and path segments
 * become tokens).
 *
 * `apply` is driven by event replay — the consumer (desktop) calls it
 * for every event applied through the reducer. Idempotent: re-applying
 * the same event is harmless (the per-itemId map overwrites).
 */
export class SearchIndex {
  // itemId → joined searchable string (lowercased), for live re-tokenisation.
  readonly #searchableByItem = new Map<string, string>();
  // itemId → set of tokens (cached, recomputed only when searchable changes).
  readonly #tokensByItem = new Map<string, Set<string>>();
  // Reverse: token → set of itemIds carrying it.
  readonly #itemsByToken = new Map<string, Set<string>>();
  // itemId → title used for the next ItemTitleEdited; mirrors the
  // projection's view of the title so the index stays consistent without
  // re-reading the projection.
  readonly #titleByItem = new Map<string, string>();
  readonly #urlByItem = new Map<string, string>();

  apply(event: Event): void {
    switch (event.type) {
      case "ItemSaved":
        this.#setItem(event.data.itemId, event.data.title, event.data.url);
        break;
      case "ItemTitleEdited":
        this.#setItem(
          event.data.itemId,
          event.data.title,
          this.#urlByItem.get(event.data.itemId) ?? "",
        );
        break;
      case "ItemDeleted":
        this.#removeItem(event.data.itemId);
        break;
      default:
        // Other events don't change the searchable fields.
        break;
    }
  }

  search(query: string, limit?: number): SearchHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    // Each query token contributes the items it appears in. Score is the
    // count of distinct query tokens the item matches.
    const scores = new Map<string, number>();
    for (const token of tokens) {
      // Match prefix + substring — for "foo" we want items containing
      // any token starting with "foo" OR an explicit token "foo". This
      // mirrors FTS5's default substring-on-prefix behaviour cheaply
      // enough at v1 scale (thousands of items).
      const matches = new Set<string>();
      for (const [indexedToken, ids] of this.#itemsByToken) {
        if (indexedToken.includes(token)) {
          for (const id of ids) matches.add(id);
        }
      }
      for (const id of matches) {
        scores.set(id, (scores.get(id) ?? 0) + 1);
      }
    }

    const hits: SearchHit[] = [];
    for (const [itemId, score] of scores) hits.push({ itemId, score });
    hits.sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
    return typeof limit === "number" ? hits.slice(0, limit) : hits;
  }

  size(): number {
    return this.#searchableByItem.size;
  }

  #setItem(itemId: string, title: string, url: string): void {
    this.#titleByItem.set(itemId, title);
    this.#urlByItem.set(itemId, url);
    const searchable = `${title} ${url}`.toLowerCase();
    this.#searchableByItem.set(itemId, searchable);

    const newTokens = new Set(tokenize(searchable));
    const oldTokens = this.#tokensByItem.get(itemId);

    if (oldTokens) {
      for (const token of oldTokens) {
        if (!newTokens.has(token)) this.#removeFromReverse(token, itemId);
      }
    }
    for (const token of newTokens) {
      if (!oldTokens || !oldTokens.has(token)) this.#addToReverse(token, itemId);
    }
    this.#tokensByItem.set(itemId, newTokens);
  }

  #removeItem(itemId: string): void {
    const tokens = this.#tokensByItem.get(itemId);
    if (tokens) {
      for (const token of tokens) this.#removeFromReverse(token, itemId);
    }
    this.#tokensByItem.delete(itemId);
    this.#searchableByItem.delete(itemId);
    this.#titleByItem.delete(itemId);
    this.#urlByItem.delete(itemId);
  }

  #addToReverse(token: string, itemId: string): void {
    let set = this.#itemsByToken.get(token);
    if (set === undefined) {
      set = new Set();
      this.#itemsByToken.set(token, set);
    }
    set.add(itemId);
  }

  #removeFromReverse(token: string, itemId: string): void {
    const set = this.#itemsByToken.get(token);
    if (set === undefined) return;
    set.delete(itemId);
    if (set.size === 0) this.#itemsByToken.delete(token);
  }
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}
