import type { Database } from "sql.js";

export type Migration = {
  version: number;
  name: string;
  up: (db: Database) => void;
};

// Migration order is the source of truth — every new schema change appends
// here, never edits an earlier entry. `applyMigrations` reads the
// `schema_version` setting and runs everything strictly greater than it.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    up(db) {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- Events table mirrors the on-wire envelope shape from @defer/core/events.
        -- 'seq' is NULL for locally-emitted events that have not yet been
        -- acknowledged by the relay; outboundFlush stamps it post-ack in a
        -- later slice. Reducer order on a single device replays in
        -- (seq IS NULL, seq, row_id) so unsynced events still apply last.
        CREATE TABLE IF NOT EXISTS events (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          seq INTEGER,
          type TEXT NOT NULL,
          device_id TEXT NOT NULL,
          client_nonce TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          payload TEXT NOT NULL,
          UNIQUE(device_id, client_nonce)
        );

        CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);

        -- Items is the materialised projection (read model). Reducer output
        -- writes here; the UI reads from here. JSON columns hold the tags
        -- array since SQLite has no native array type.
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          liked INTEGER NOT NULL,
          tags_json TEXT NOT NULL,
          saved_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          deleted_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_items_canonical_url ON items(canonical_url);
        CREATE INDEX IF NOT EXISTS idx_items_state ON items(state);
      `);
    },
  },
  // FTS5 virtual table lives in slice #52 (local search) — sql.js's stock
  // wasm build omits the FTS5 extension, so the table can't be created
  // today and the migration framework is what's "in place" instead. When
  // #52 lands it will ship a sql.js build with FTS5 enabled (or a swap to
  // tauri-plugin-sql) and append the `items_fts` migration here as
  // version 2.
];

export function applyMigrations(db: Database, now: number): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);`,
  );

  const current = readSchemaVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    migration.up(db);
    db.run(`INSERT INTO schema_version(version, applied_at) VALUES (?, ?);`, [
      migration.version,
      now,
    ]);
  }
}

export function readSchemaVersion(db: Database): number {
  // The table might not exist on a brand-new database; the caller must have
  // CREATE'd it before invoking this on a fresh schema.
  const result = db.exec(`SELECT MAX(version) AS v FROM schema_version;`);
  if (result.length === 0) return 0;
  const row = result[0]?.values[0];
  if (!row) return 0;
  const v = row[0];
  return typeof v === "number" ? v : 0;
}
