import type { Item } from "@defer/core";

export type StoredEventRow = {
  rowId: number;
  seq: number | null;
  type: string;
  deviceId: string;
  clientNonce: string;
  timestamp: number;
  payload: string;
};

export type StoredSetting = {
  key: string;
  value: string;
};

export interface StoragePort {
  init(): Promise<void>;

  appendEvent(args: {
    seq: number | null;
    type: string;
    deviceId: string;
    clientNonce: string;
    timestamp: number;
    payload: string;
  }): Promise<void>;

  allEvents(): Promise<StoredEventRow[]>;

  putItem(item: Item): Promise<void>;

  putItems(items: Item[]): Promise<void>;

  allItems(): Promise<Item[]>;

  getSetting(key: string): Promise<string | undefined>;

  setSetting(key: string, value: string): Promise<void>;

  /**
   * Returns the raw database bytes for persistence. Adapter consumers
   * (Tauri filesystem, browser indexedDB, etc.) write these out.
   */
  exportBytes(): Uint8Array;

  close(): Promise<void>;
}
