export type ItemState = "inbox" | "archive";

export type Item = {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  state: ItemState;
  liked: boolean;
  tags: string[]; // sorted ascending for determinism
  savedAt: number;
  createdAt: number;
  deletedAt: number | null;
};

export type DeviceRecord = {
  name: string;
  type: string;
  registeredAt: number;
};

export type ScheduledDeletion = {
  scheduledFor: number;
  scheduledBy: string; // deviceId from the event envelope
};

export type VaultState = {
  items: ReadonlyMap<string, Item>;
  itemsByCanonicalUrl: ReadonlyMap<string, string>;
  tags: ReadonlySet<string>;
  devices: ReadonlyMap<string, DeviceRecord>;
  scheduledDeletion: ScheduledDeletion | null;
  isDeleted: boolean;
};

export function initialVaultState(): VaultState {
  return {
    items: new Map(),
    itemsByCanonicalUrl: new Map(),
    tags: new Set(),
    devices: new Map(),
    scheduledDeletion: null,
    isDeleted: false,
  };
}

// Internal helpers shared by reducer modules. Not part of the public API.

export function cloneItem(item: Item, patch: Partial<Item>): Item {
  return { ...item, ...patch };
}

export function recomputeTags(items: ReadonlyMap<string, Item>): Set<string> {
  const next = new Set<string>();
  for (const item of items.values()) {
    if (item.deletedAt !== null) continue;
    for (const tag of item.tags) next.add(tag);
  }
  return next;
}
