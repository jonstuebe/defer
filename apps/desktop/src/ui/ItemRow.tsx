import type { Item } from "@defer/core";

type ItemRowProps = {
  item: Item;
  selected: boolean;
  onOpen: () => void;
  onToggleDetails: () => void;
};

export function ItemRow({ item, selected, onOpen, onToggleDetails }: ItemRowProps) {
  const host = safeHostname(item.url);
  return (
    <li className={`item-row with-button ${selected ? "selected" : ""}`}>
      <button
        type="button"
        className="row-body"
        onClick={onOpen}
        aria-label={`Open ${item.title || item.url} in browser`}
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          padding: 0,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span className="title">{item.title || item.url}</span>
        <div className="meta">
          <span>{host}</span>
          <span>{formatRelative(item.savedAt)}</span>
        </div>
      </button>
      <button
        type="button"
        className="details-btn"
        onClick={onToggleDetails}
        aria-label={`Toggle details for ${item.title || item.url}`}
        aria-pressed={selected}
      >
        Details
      </button>
    </li>
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatRelative(savedAt: number): string {
  const diffMs = Date.now() - savedAt;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
