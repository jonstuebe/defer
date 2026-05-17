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

  /**
   * Stamps the relay-assigned `seq` onto a previously-locally-emitted
   * event row, identified by its `(deviceId, clientNonce)` tuple (the
   * `UNIQUE` index from the v1 migration). No-op if no matching row
   * exists — defensive against an `onSeqAssigned` callback firing after
   * the events table was cleared (e.g., by `vaultWipe` in slice #60).
   */
  stampEventSeq(deviceId: string, clientNonce: string, seq: number): Promise<void>;

  putItem(item: Item): Promise<void>;

  putItems(items: Item[]): Promise<void>;

  allItems(): Promise<Item[]>;

  getSetting(key: string): Promise<string | undefined>;

  setSetting(key: string, value: string): Promise<void>;

  /**
   * Stamps the local-only "I opened this item" timestamp. Used for the
   * dimming signal (PRD US #46) — per CONTEXT.md this is device-local
   * and never emitted as an event. Idempotent: re-opening the same item
   * overwrites with the newer timestamp.
   */
  markItemOpened(itemId: string, openedAt: number): Promise<void>;

  /**
   * Returns the device-local `lastOpenedAt` map. Used by the UI to apply
   * dimmed styling to rows the user has already opened.
   */
  getLastOpenedTimestamps(): Promise<ReadonlyMap<string, number>>;

  /**
   * Returns the raw database bytes for persistence. Adapter consumers
   * (Tauri filesystem, browser indexedDB, etc.) write these out.
   */
  exportBytes(): Uint8Array;

  close(): Promise<void>;
}
