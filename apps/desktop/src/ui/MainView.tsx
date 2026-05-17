import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Item } from "@defer/core";

import type { VaultProjectionStore } from "../vault/projection-store.js";
import type { VaultCommands } from "../vault/commands.js";
import type { LastOpenedStore } from "../runtime/last-opened-store.js";
import { openExternalUrl } from "../runtime/url-opener.js";

import { Sidebar, type SidebarFilter } from "./Sidebar.js";
import { DetailPane } from "./DetailPane.js";
import { ItemRow } from "./ItemRow.js";
import { SaveBar } from "./SaveBar.js";
import { filterItems } from "./filter-items.js";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts.js";

type MainViewProps = {
  projection: VaultProjectionStore;
  commands: VaultCommands;
  lastOpened: LastOpenedStore;
  onRefresh: () => void;
};

/**
 * The 3-pane main UI (PRD US #38). Composes Sidebar (state/tag filter),
 * the list (filtered by sidebar selection), and DetailPane (per-item
 * management). Slice #51 adds keyboard navigation and the device-local
 * "I opened this URL" dim signal.
 */
export function MainView({ projection, commands, lastOpened, onRefresh }: MainViewProps) {
  const allItems = useProjectionItems(projection);
  const allTags = useProjectionTags(projection);
  const lastOpenedMap = useLastOpenedSnapshot(lastOpened);
  const [filter, setFilter] = useState<SidebarFilter>({ kind: "inbox" });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  // Future slice #52 hooks this ref to focus the search input on ⌘F.
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => filterItems(allItems, filter), [allItems, filter]);
  const selectedItem = useMemo(
    () =>
      selectedItemId === null ? null : (allItems.find((i) => i.id === selectedItemId) ?? null),
    [allItems, selectedItemId],
  );
  const focusedItem = filtered[Math.min(focusedIndex, filtered.length - 1)] ?? null;

  const detailOpen = selectedItem !== null;

  async function handleSave(url: string) {
    await commands.save(url);
  }

  const handleOpen = useCallback(
    (item: Item) => {
      void openExternalUrl(item.url);
      void lastOpened.markOpened(item.id);
    },
    [lastOpened],
  );

  function handleToggleDetails(itemId: string) {
    setSelectedItemId((current) => (current === itemId ? null : itemId));
  }

  // Keyboard handlers are recreated when selection or focused-index
  // changes — required since they close over those values. The hook
  // re-binds the document listener on each handler instance; React's
  // dependency check means we don't double-bind.
  useKeyboardShortcuts({
    onEnter: () => {
      if (focusedItem !== null) handleOpen(focusedItem);
    },
    onSpace: () => {
      if (focusedItem !== null) handleToggleDetails(focusedItem.id);
    },
    onFindFocus: () => {
      // Slice #52 mounts the search input and wires this. The ref is in
      // place so #52's wiring is purely additive.
      searchInputRef.current?.focus();
    },
    onMoveUp: () => {
      setFocusedIndex((i) => Math.max(0, i - 1));
    },
    onMoveDown: () => {
      setFocusedIndex((i) => Math.min(filtered.length - 1, i + 1));
    },
  });

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
          setFocusedIndex(0);
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
            {filtered.map((item, index) => (
              <ItemRow
                key={item.id}
                item={item}
                selected={item.id === selectedItemId}
                focused={index === focusedIndex}
                opened={lastOpenedMap.has(item.id)}
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

const TAGS_CACHE = new WeakMap<ReadonlySet<string>, readonly string[]>();

function getSortedTagsFromProjection(projection: VaultProjectionStore): readonly string[] {
  const set = projection.getState().tags;
  const cached = TAGS_CACHE.get(set);
  if (cached !== undefined) return cached;
  const sorted = [...set].sort((a, b) => a.localeCompare(b));
  TAGS_CACHE.set(set, sorted);
  return sorted;
}

function useLastOpenedSnapshot(store: LastOpenedStore): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
}
