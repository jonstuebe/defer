export type SidebarFilter = "inbox" | "archive" | "liked";

type SidebarProps = {
  selected: SidebarFilter;
  onSelect: (filter: SidebarFilter) => void;
};

/**
 * Left pane of the 3-pane layout. PRD US #39 fixes the order: **Inbox**,
 * **Archive**, **Liked** at the top (always visible), then a tags section
 * below. Tags are a placeholder in this slice — `ItemTagged`/`ItemUntagged`
 * wiring lands in slice #50.
 */
export function Sidebar({ selected, onSelect }: SidebarProps) {
  return (
    <nav className="layout-sidebar" aria-label="States and tags">
      <div className="sidebar-section">
        <h2>States</h2>
        <button
          type="button"
          className={`sidebar-item ${selected === "inbox" ? "active" : ""}`}
          onClick={() => onSelect("inbox")}
        >
          Inbox
        </button>
        <button
          type="button"
          className={`sidebar-item ${selected === "archive" ? "active" : ""}`}
          onClick={() => onSelect("archive")}
        >
          Archive
        </button>
        <button
          type="button"
          className={`sidebar-item ${selected === "liked" ? "active" : ""}`}
          onClick={() => onSelect("liked")}
        >
          Liked
        </button>
      </div>
      <div className="sidebar-section">
        <h2>Tags</h2>
        <p className="sidebar-placeholder">Coming in slice #50</p>
      </div>
    </nav>
  );
}
