import { useEffect, useState } from "react";
import type { Item } from "@defer/core";

import type { VaultCommands } from "../vault/commands.js";

type DetailPaneProps = {
  item: Item | null;
  commands: VaultCommands;
};

/**
 * Right pane of the 3-pane layout. Hosts the per-item management UI
 * (PRD US #45): full URL + copy, editable title, state controls
 * (Archive/Unarchive, Like/Unlike), timestamps, delete.
 *
 * `commands` is passed in so the pane can stay a presentation component
 * — it never builds events directly; everything routes through the
 * `vaultCommands` API. Delete uses an inline confirm (no modal) per
 * the slice description.
 */
export function DetailPane({ item, commands }: DetailPaneProps) {
  if (item === null) {
    return (
      <aside className="layout-detail">
        <p className="detail-pane-placeholder">Select an item's "Details" button to see more.</p>
      </aside>
    );
  }
  return <DetailPaneFor item={item} commands={commands} />;
}

function DetailPaneFor({ item, commands }: { item: Item; commands: VaultCommands }) {
  // The pane gets a fresh key per item (see MainView), so `useState`
  // initializers see the right item. Editing title is local state that
  // commits on blur or ⌘+S; cancelling via Esc reverts.
  const [titleDraft, setTitleDraft] = useState(item.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  // Keep the draft in sync when the underlying item changes (e.g., remote
  // edit arriving via inbound sync).
  useEffect(() => {
    setTitleDraft(item.title);
  }, [item.id, item.title]);

  async function commitTitle() {
    const next = titleDraft.trim();
    if (next === item.title) return;
    await commands.editTitle(item.id, next);
  }

  async function handleCopy() {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <aside className="layout-detail">
      <section className="col">
        <div>
          <label htmlFor="detail-title" className="muted" style={{ fontSize: 11 }}>
            Title
          </label>
          <input
            id="detail-title"
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setTitleDraft(item.title);
                e.currentTarget.blur();
              } else if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
        </div>

        <div>
          <span className="muted" style={{ fontSize: 11 }}>
            URL
          </span>
          <div style={{ wordBreak: "break-all", fontSize: 12, marginTop: 4 }}>{item.url}</div>
          <button
            type="button"
            className="secondary"
            onClick={handleCopy}
            style={{ marginTop: 6, fontSize: 12 }}
          >
            {copied ? "Copied" : "Copy URL"}
          </button>
        </div>

        <div className="row" style={{ flexWrap: "wrap" }}>
          {item.state === "inbox" ? (
            <button type="button" onClick={() => void commands.archive(item.id)}>
              Archive
            </button>
          ) : (
            <button type="button" onClick={() => void commands.unarchive(item.id)}>
              Unarchive
            </button>
          )}
          {item.liked ? (
            <button
              type="button"
              className="secondary"
              onClick={() => void commands.unlike(item.id)}
            >
              Unlike
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => void commands.like(item.id)}>
              Like
            </button>
          )}
        </div>

        <div className="muted" style={{ fontSize: 12 }}>
          Saved {formatAbsolute(item.savedAt)}
          {item.createdAt !== item.savedAt
            ? ` (first saved ${formatAbsolute(item.createdAt)})`
            : ""}
        </div>

        <div style={{ marginTop: 8 }}>
          {confirmDelete ? (
            <div className="row">
              <button
                type="button"
                style={{ background: "var(--danger)" }}
                onClick={async () => {
                  await commands.deleteItem(item.id);
                  setConfirmDelete(false);
                }}
              >
                Confirm delete
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="secondary"
              style={{ color: "var(--danger)" }}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          )}
        </div>
      </section>
    </aside>
  );
}

function formatAbsolute(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
