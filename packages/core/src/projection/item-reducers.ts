import type {
  ItemSaved,
  ItemArchived,
  ItemUnarchived,
  ItemLiked,
  ItemUnliked,
  ItemTagged,
  ItemUntagged,
  ItemTitleEdited,
  ItemDeleted,
} from "../events/index.js";
import { cloneItem, recomputeTags, type Item, type VaultState } from "./state.js";

export function applyItemSaved(state: VaultState, event: ItemSaved): VaultState {
  const { data } = event;
  const existingItemId = state.itemsByCanonicalUrl.get(data.canonicalUrl);

  if (existingItemId !== undefined) {
    const existing = state.items.get(existingItemId);
    if (existing && existing.deletedAt === null) {
      // Touch: bump savedAt and return to inbox regardless of prior state.
      // If both already match, this is an idempotent re-apply — return identity.
      if (existing.savedAt === data.savedAt && existing.state === "inbox") {
        return state;
      }
      const touched = cloneItem(existing, {
        savedAt: data.savedAt,
        state: "inbox",
      });
      const items = new Map(state.items);
      items.set(existing.id, touched);
      return { ...state, items };
    }
  }

  // Idempotent re-apply guard: if items already has this id, no-op.
  if (state.items.has(data.itemId)) {
    return state;
  }

  const newItem: Item = {
    id: data.itemId,
    url: data.url,
    canonicalUrl: data.canonicalUrl,
    title: data.title,
    state: "inbox",
    liked: false,
    tags: [],
    savedAt: data.savedAt,
    createdAt: event.timestamp,
    deletedAt: null,
  };

  const items = new Map(state.items);
  items.set(data.itemId, newItem);
  const itemsByCanonicalUrl = new Map(state.itemsByCanonicalUrl);
  itemsByCanonicalUrl.set(data.canonicalUrl, data.itemId);

  return { ...state, items, itemsByCanonicalUrl };
}

function patchLiveItem(state: VaultState, itemId: string, patch: Partial<Item>): VaultState {
  const item = state.items.get(itemId);
  if (!item || item.deletedAt !== null) return state;

  // Idempotency optimisation: if nothing actually changes, bail.
  let changed = false;
  for (const key of Object.keys(patch) as (keyof Item)[]) {
    if (item[key] !== patch[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return state;

  const next = cloneItem(item, patch);
  const items = new Map(state.items);
  items.set(itemId, next);
  return { ...state, items };
}

export function applyItemArchived(state: VaultState, event: ItemArchived): VaultState {
  return patchLiveItem(state, event.data.itemId, { state: "archive" });
}

export function applyItemUnarchived(state: VaultState, event: ItemUnarchived): VaultState {
  return patchLiveItem(state, event.data.itemId, { state: "inbox" });
}

export function applyItemLiked(state: VaultState, event: ItemLiked): VaultState {
  return patchLiveItem(state, event.data.itemId, { liked: true });
}

export function applyItemUnliked(state: VaultState, event: ItemUnliked): VaultState {
  return patchLiveItem(state, event.data.itemId, { liked: false });
}

export function applyItemTitleEdited(state: VaultState, event: ItemTitleEdited): VaultState {
  return patchLiveItem(state, event.data.itemId, { title: event.data.title });
}

export function applyItemTagged(state: VaultState, event: ItemTagged): VaultState {
  const { itemId, tag } = event.data;
  const item = state.items.get(itemId);
  if (!item || item.deletedAt !== null) return state;
  if (item.tags.includes(tag)) return state;

  const nextTags = [...item.tags, tag].sort();
  const next = cloneItem(item, { tags: nextTags });
  const items = new Map(state.items);
  items.set(itemId, next);

  const tags = new Set(state.tags);
  tags.add(tag);

  return { ...state, items, tags };
}

export function applyItemUntagged(state: VaultState, event: ItemUntagged): VaultState {
  const { itemId, tag } = event.data;
  const item = state.items.get(itemId);
  if (!item || item.deletedAt !== null) return state;
  if (!item.tags.includes(tag)) return state;

  const next = cloneItem(item, { tags: item.tags.filter((t) => t !== tag) });
  const items = new Map(state.items);
  items.set(itemId, next);

  const tags = recomputeTags(items);
  return { ...state, items, tags };
}

export function applyItemDeleted(state: VaultState, event: ItemDeleted): VaultState {
  const { itemId } = event.data;
  const item = state.items.get(itemId);
  if (!item) return state;
  if (item.deletedAt !== null) return state;

  const next = cloneItem(item, { deletedAt: event.timestamp });
  const items = new Map(state.items);
  items.set(itemId, next);

  const itemsByCanonicalUrl = new Map(state.itemsByCanonicalUrl);
  itemsByCanonicalUrl.delete(item.canonicalUrl);

  const tags = recomputeTags(items);

  return { ...state, items, itemsByCanonicalUrl, tags };
}
