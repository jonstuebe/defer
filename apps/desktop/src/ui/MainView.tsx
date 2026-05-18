import { useMemo, useState, useSyncExternalStore } from "react";
import type { Item } from "@defer/core";

import type { VaultProjectionStore } from "../vault/projection-store.js";
import type { VaultCommands } from "../vault/commands.js";
import { openExternalUrl } from "../runtime/url-opener.js";

import { Sidebar, type SidebarFilter } from "./Sidebar.js";
import { DetailPane } from "./DetailPane.js";
import { ItemRow } from "./ItemRow.js";
import { SaveBar } from "./SaveBar.js";
import { filterItems } from "./filter-items.js";

type MainViewProps = {
  projection: VaultProjectionStore;
  commands: VaultCommands;
  onRefresh: () => void;
};

/**
 * The 3-pane main UI (PRD US #38). Composes Sidebar (state/tag filter),
 * the list (filtered by sidebar selection), and DetailPane (per-item
 * management — content lands in slice #49). Clicking a row body opens
 * the URL via Tauri shell (PRD US #42); the dedicated Details button
 * toggles the detail pane (PRD US #43).
 */
export function MainView({ projection, commands, onRefresh }: MainViewProps) {
  const allItems = useProjectionItems(projection);
  const allTags = useProjectionTags(projection);
  const [filter, setFilter] = useState<SidebarFilter>({ kind: "inbox" });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const filtered = useMemo(() => filterItems(allItems, filter), [allItems, filter]);
  const selectedItem = useMemo(
    () =>
      selectedItemId === null ? null : (allItems.find((i) => i.id === selectedItemId) ?? null),
    [allItems, selectedItemId],
  );

  const detailOpen = selectedItem !== null;

  async function handleSave(url: string) {
    await commands.save(url);
  }

  function handleOpen(item: Item) {
    void openExternalUrl(item.url);
  }

  function handleToggleDetails(itemId: string) {
    setSelectedItemId((current) => (current === itemId ? null : itemId));
  }

  return (
    <div className={`layout ${detailOpen ? "" : "detail-closed"}`}>
      <Sidebar
        selected={filter}
        tags={allTags}
        onSelect={(next) => {
          setFilter(next);
          // Selection in another view is stale — close the detail pane so
          // we don't show a row no longer visible in the filtered list.
          setSelectedItemId(null);
        }}
      />
      <main className="layout-list">
        <header className="layout-list-header">
          <h1>{titleForFilter(filter)}</h1>
          <button
            type="button"
            className="secondary"
            onClick={onRefresh}
            aria-label="Refresh — pull latest events from the relay"
          >
            Refresh
          </button>
        </header>
        <SaveBar onSave={handleSave} />
        {filtered.length === 0 ? (
          <div className="layout-list-empty">
            {filter.kind === "inbox"
              ? "Save a link from the Chrome extension, or paste a URL above."
              : `Nothing in ${titleForFilter(filter)} yet.`}
          </div>
        ) : (
          <ul className="item-list">
            {filtered.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                selected={item.id === selectedItemId}
                onOpen={() => handleOpen(item)}
                onToggleDetails={() => handleToggleDetails(item.id)}
              />
            ))}
          </ul>
        )}
      </main>
      <DetailPane
        key={selectedItem?.id ?? "none"}
        item={selectedItem}
        allTags={allTags}
        commands={commands}
      />
    </div>
  );
}

function titleForFilter(filter: SidebarFilter): string {
  switch (filter.kind) {
    case "inbox":
      return "Inbox";
    case "archive":
      return "Archive";
    case "liked":
      return "Liked";
    case "tag":
      return `#${filter.tag}`;
  }
}

function useProjectionItems(projection: VaultProjectionStore): readonly Item[] {
  return useSyncExternalStore(
    (listener) => projection.subscribe(listener),
    () => projection.getItemsSortedBySavedAtDesc(),
    () => projection.getItemsSortedBySavedAtDesc(),
  );
}

function useProjectionTags(projection: VaultProjectionStore): readonly string[] {
  return useSyncExternalStore(
    (listener) => projection.subscribe(listener),
    () => getSortedTagsFromProjection(projection),
    () => getSortedTagsFromProjection(projection),
  );
}

// Memoized accessor — `useSyncExternalStore`'s `getSnapshot` requires a
// stable reference for identical state. We compute once per projection
// state revision and cache the result, keyed by the underlying tags set.
const TAGS_CACHE = new WeakMap<ReadonlySet<string>, readonly string[]>();

function getSortedTagsFromProjection(projection: VaultProjectionStore): readonly string[] {
  const set = projection.getState().tags;
  const cached = TAGS_CACHE.get(set);
  if (cached !== undefined) return cached;
  const sorted = [...set].sort((a, b) => a.localeCompare(b));
  TAGS_CACHE.set(set, sorted);
  return sorted;
}
