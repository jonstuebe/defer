import type { Item } from "@defer/core";

import type { SidebarFilter } from "./Sidebar.js";

/**
 * Applies the sidebar's selected state filter to the projection's items.
 *
 * Per CONTEXT.md: **Inbox** and **Archive** are mutually-exclusive states,
 * **Liked** is an independent flag that can co-exist with either state.
 * So the Liked filter spans inbox-and-archive — clicking it shows every
 * item the user has liked, regardless of state. That matches PRD US #53.
 *
 * Soft-deleted items (`deletedAt !== null`) are excluded from every view.
 * The projection-store already filters them in `getItemsSortedBySavedAtDesc`,
 * but we re-check here so this helper is correct against any item source.
 */
export function filterItems(items: readonly Item[], filter: SidebarFilter): Item[] {
  return items.filter((item) => {
    if (item.deletedAt !== null) return false;
    switch (filter) {
      case "inbox":
        return item.state === "inbox";
      case "archive":
        return item.state === "archive";
      case "liked":
        return item.liked;
    }
  });
}
