import { useMemo, useState } from "react";

import type { VaultCommands } from "../vault/commands.js";

type TagEditorProps = {
  itemId: string;
  itemTags: readonly string[];
  allTags: readonly string[];
  commands: VaultCommands;
};

/**
 * Tag editor for the detail pane. Type to add a new tag; pick from the
 * autocomplete dropdown (showing every tag in the vault that matches the
 * prefix and isn't already on this item — PRD US #29, #45). Tag matching
 * is case-sensitive throughout (CONTEXT.md), so `Rust` and `rust` are
 * distinct.
 *
 * Removing a chip emits `ItemUntagged`. Adding a chip emits `ItemTagged`.
 * Both go through `vaultCommands` so the projection updates immediately
 * and the events flush to the relay in the background.
 */
export function TagEditor({ itemId, itemTags, allTags, commands }: TagEditorProps) {
  const [draft, setDraft] = useState("");

  const suggestions = useMemo(() => {
    const q = draft.trim();
    if (q === "") return [];
    const onItem = new Set(itemTags);
    return allTags.filter((tag) => tag.includes(q) && !onItem.has(tag)).slice(0, 10);
  }, [draft, allTags, itemTags]);

  async function addTag(tag: string) {
    const normalized = tag.trim();
    if (normalized === "" || itemTags.includes(normalized)) {
      setDraft("");
      return;
    }
    await commands.tag(itemId, normalized);
    setDraft("");
  }

  return (
    <div className="tag-editor">
      <span className="muted" style={{ fontSize: 11 }}>
        Tags
      </span>
      <div className="tag-chips">
        {itemTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag-chip"
            onClick={() => void commands.untag(itemId, tag)}
            aria-label={`Remove tag ${tag}`}
            title={`Remove ${tag}`}
          >
            {tag} ×
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder="Add a tag"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void addTag(draft);
          } else if (e.key === "Escape") {
            setDraft("");
            e.currentTarget.blur();
          }
        }}
      />
      {suggestions.length > 0 ? (
        <div className="tag-suggestions" aria-label="Tag suggestions">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="tag-suggestion"
              onClick={() => void addTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
