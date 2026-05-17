import type { Database, SqlJsStatic } from "sql.js";
import type { Item } from "@defer/core";

import type { StoragePort, StoredEventRow } from "./types.js";
import { applyMigrations } from "./migrations.js";

export type SqliteStorageOpts = {
  /** Existing serialized database to load from. New DB if omitted. */
  existingDbBytes?: Uint8Array;
  /** Clock injection. Defaults to Date.now. */
  now?: () => number;
};

export class SqliteStorage implements StoragePort {
  readonly #db: Database;
  readonly #now: () => number;
  #initialized = false;

  constructor(SQL: SqlJsStatic, opts: SqliteStorageOpts = {}) {
    this.#db = opts.existingDbBytes ? new SQL.Database(opts.existingDbBytes) : new SQL.Database();
    this.#now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    applyMigrations(this.#db, this.#now());
    this.#initialized = true;
  }

  async appendEvent(args: {
    seq: number | null;
    type: string;
    deviceId: string;
    clientNonce: string;
    timestamp: number;
    payload: string;
  }): Promise<void> {
    // INSERT OR IGNORE keeps `(device_id, client_nonce)` idempotent — a
    // retried local emit (after a crash) does not duplicate the event row,
    // matching ADR-0006 §4.2's relay-side dedupe contract.
    this.#db.run(
      `INSERT OR IGNORE INTO events(seq, type, device_id, client_nonce, timestamp, payload)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [args.seq, args.type, args.deviceId, args.clientNonce, args.timestamp, args.payload],
    );
  }

  async allEvents(): Promise<StoredEventRow[]> {
    const result = this.#db.exec(
      // NULL seqs sort after numbered seqs so locally-emitted but
      // unacknowledged events apply at the tail of replay.
      `SELECT row_id, seq, type, device_id, client_nonce, timestamp, payload
       FROM events
       ORDER BY (seq IS NULL), seq, row_id;`,
    );
    if (result.length === 0) return [];
    const rows = result[0]?.values ?? [];
    return rows.map((row) => ({
      rowId: row[0] as number,
      seq: (row[1] as number | null) ?? null,
      type: row[2] as string,
      deviceId: row[3] as string,
      clientNonce: row[4] as string,
      timestamp: row[5] as number,
      payload: row[6] as string,
    }));
  }

  async putItem(item: Item): Promise<void> {
    this.#db.run(
      `INSERT INTO items(id, url, canonical_url, title, state, liked, tags_json, saved_at, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         url = excluded.url,
         canonical_url = excluded.canonical_url,
         title = excluded.title,
         state = excluded.state,
         liked = excluded.liked,
         tags_json = excluded.tags_json,
         saved_at = excluded.saved_at,
         created_at = excluded.created_at,
         deleted_at = excluded.deleted_at;`,
      [
        item.id,
        item.url,
        item.canonicalUrl,
        item.title,
        item.state,
        item.liked ? 1 : 0,
        JSON.stringify(item.tags),
        item.savedAt,
        item.createdAt,
        item.deletedAt,
      ],
    );
  }

  async putItems(items: Item[]): Promise<void> {
    if (items.length === 0) return;
    this.#db.run("BEGIN;");
    try {
      for (const item of items) {
        await this.putItem(item);
      }
      this.#db.run("COMMIT;");
    } catch (err) {
      this.#db.run("ROLLBACK;");
      throw err;
    }
  }

  async allItems(): Promise<Item[]> {
    const result = this.#db.exec(
      `SELECT id, url, canonical_url, title, state, liked, tags_json, saved_at, created_at, deleted_at
       FROM items
       WHERE deleted_at IS NULL
       ORDER BY saved_at DESC, id;`,
    );
    if (result.length === 0) return [];
    const rows = result[0]?.values ?? [];
    return rows.map((row) => ({
      id: row[0] as string,
      url: row[1] as string,
      canonicalUrl: row[2] as string,
      title: row[3] as string,
      state: row[4] as "inbox" | "archive",
      liked: (row[5] as number) !== 0,
      tags: JSON.parse(row[6] as string) as string[],
      savedAt: row[7] as number,
      createdAt: row[8] as number,
      deletedAt: (row[9] as number | null) ?? null,
    }));
  }

  async getSetting(key: string): Promise<string | undefined> {
    const result = this.#db.exec(`SELECT value FROM settings WHERE key = ?;`, [key]);
    if (result.length === 0) return undefined;
    const row = result[0]?.values[0];
    return row ? (row[0] as string) : undefined;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.#db.run(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [key, value],
    );
  }

  exportBytes(): Uint8Array {
    return this.#db.export();
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
