import initSqlJs, { type SqlJsStatic } from "sql.js";

export type SqlJsInitOptions = {
  /**
   * Resolves the path to a sql.js asset (`sql-wasm.wasm` etc). In a Tauri
   * webview build the wasm is bundled as a static asset; in Node tests we
   * read it directly from `node_modules`.
   */
  locateFile?: (file: string) => string;
  /**
   * Pre-loaded wasm bytes. If provided, takes precedence over `locateFile`.
   */
  wasmBinary?: ArrayBuffer;
};

let initPromise: Promise<SqlJsStatic> | null = null;

export function initSql(options: SqlJsInitOptions = {}): Promise<SqlJsStatic> {
  if (initPromise) return initPromise;
  initPromise = initSqlJs(options).catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

// Test helper — drops the cached init so a test can switch wasm sources.
// Not exported from the package barrel; tests import directly.
export function resetSqlInitForTests(): void {
  initPromise = null;
}
