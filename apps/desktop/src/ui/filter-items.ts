import type { Item } from "@defer/core";

import type { SidebarFilter } from "./Sidebar.js";

/**
 * Applies the sidebar's selected filter to the projection's items.
 *
 * Per CONTEXT.md: **Inbox** and **Archive** are mutually-exclusive states,
 * **Liked** is an independent flag that can co-exist with either state, and
 * **Tag** is a topic label distinct from state. So:
 * - "inbox"/"archive": filter by `item.state`
 * - "liked": spans both states (PRD US #53)
 * - "tag": filter by tag membership, regardless of state
 *
 * Tag matching is case-sensitive (PRD US #55 / CONTEXT.md — no auto-merge
 * of `Rust` / `rust`). Soft-deleted items are excluded from every view.
 */
export function filterItems(items: readonly Item[], filter: SidebarFilter): Item[] {
  return items.filter((item) => {
    if (item.deletedAt !== null) return false;
    switch (filter.kind) {
      case "inbox":
        return item.state === "inbox";
      case "archive":
        return item.state === "archive";
      case "liked":
        return item.liked;
      case "tag":
        return item.tags.includes(filter.tag);
    }
  });
}
