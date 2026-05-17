import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { SqlJsStatic } from "sql.js";

import { initSql, resetSqlInitForTests } from "../src/storage/sql-js-init.js";

/**
 * Loads sql.js with the WASM binary read directly from `node_modules`.
 * Vitest runs in the host Node process, so the browser-shaped
 * `locateFile` path is unreachable; we feed `wasmBinary` instead.
 */
export async function initSqlForNode(): Promise<SqlJsStatic> {
  // `createRequire` is the standard Node ESM escape hatch for
  // `require.resolve`. We use it to locate sql.js's wasm without
  // hardcoding the workspace's node_modules layout (hoisted vs nested).
  const requireFrom = createRequire(import.meta.url);
  const wasmPath = requireFrom.resolve("sql.js/dist/sql-wasm.wasm");
  const bytes = readFileSync(wasmPath);
  // Cast to ArrayBuffer — Buffer is a Uint8Array view, and sql.js's
  // emscripten typings want ArrayBuffer specifically.
  const wasmBinary = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return initSql({ wasmBinary });
}

export function resetSqlInit(): void {
  resetSqlInitForTests();
}
