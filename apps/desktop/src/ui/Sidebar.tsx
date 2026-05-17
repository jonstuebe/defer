export type SidebarFilter =
  | { kind: "inbox" }
  | { kind: "archive" }
  | { kind: "liked" }
  | { kind: "tag"; tag: string };

export function isFilterEqual(a: SidebarFilter, b: SidebarFilter): boolean {
  if (a.kind === "tag" && b.kind === "tag") return a.tag === b.tag;
  return a.kind === b.kind;
}

type SidebarProps = {
  selected: SidebarFilter;
  onSelect: (filter: SidebarFilter) => void;
  tags: readonly string[];
};

/**
 * Left pane of the 3-pane layout. PRD US #39 fixes the order: **Inbox**,
 * **Archive**, **Liked** at the top (always visible), then a tags section
 * below. Tags are a placeholder in this slice — `ItemTagged`/`ItemUntagged`
 * wiring lands in slice #50.
 */
export function Sidebar({ selected, onSelect, tags }: SidebarProps) {
  const isActive = (filter: SidebarFilter) => (isFilterEqual(selected, filter) ? "active" : "");
  return (
    <nav className="layout-sidebar" aria-label="States and tags">
      <div className="sidebar-section">
        <h2>States</h2>
        <button
          type="button"
          className={`sidebar-item ${isActive({ kind: "inbox" })}`}
          onClick={() => onSelect({ kind: "inbox" })}
        >
          Inbox
        </button>
        <button
          type="button"
          className={`sidebar-item ${isActive({ kind: "archive" })}`}
          onClick={() => onSelect({ kind: "archive" })}
        >
          Archive
        </button>
        <button
          type="button"
          className={`sidebar-item ${isActive({ kind: "liked" })}`}
          onClick={() => onSelect({ kind: "liked" })}
        >
          Liked
        </button>
      </div>
      <div className="sidebar-section">
        <h2>Tags</h2>
        {tags.length === 0 ? (
          <p className="sidebar-placeholder">No tags yet</p>
        ) : (
          tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`sidebar-item ${isActive({ kind: "tag", tag })}`}
              onClick={() => onSelect({ kind: "tag", tag })}
            >
              {tag}
            </button>
          ))
        )}
      </div>
    </nav>
  );
}
