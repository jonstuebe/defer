import type { Item } from "@defer/core";

type DetailPaneProps = {
  item: Item | null;
};

/**
 * Right pane of the 3-pane layout. Slice #48 ships the shell with a
 * minimal "selected item summary" — the full per-item management UI
 * (editable title, state controls, copy URL, tag editor, delete) lands
 * in slice #49 alongside the item-operation commands.
 */
export function DetailPane({ item }: DetailPaneProps) {
  if (item === null) {
    return (
      <aside className="layout-detail">
        <p className="detail-pane-placeholder">Select an item's "Details" button to see more.</p>
      </aside>
    );
  }
  return (
    <aside className="layout-detail">
      <h2 style={{ marginTop: 0, fontSize: 16 }}>{item.title || "(untitled)"}</h2>
      <p
        style={{
          fontSize: 12,
          color: "var(--muted)",
          wordBreak: "break-all",
          marginTop: 0,
        }}
      >
        {item.url}
      </p>
      <p className="detail-pane-placeholder" style={{ marginTop: 32 }}>
        Edit title, state controls, tags, and delete arrive in slice #49.
      </p>
    </aside>
  );
}
