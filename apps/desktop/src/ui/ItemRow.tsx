import type { Item } from "@defer/core";

type ItemRowProps = {
  item: Item;
  onOpen: () => void;
};

export function ItemRow({ item, onOpen }: ItemRowProps) {
  const host = safeHostname(item.url);
  return (
    <li
      className="item-row"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
      tabIndex={0}
    >
      <span className="title">{item.title || item.url}</span>
      <div className="meta">
        <span>{host}</span>
        <span>{formatRelative(item.savedAt)}</span>
      </div>
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
