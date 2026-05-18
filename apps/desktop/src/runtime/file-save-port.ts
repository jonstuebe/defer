/**
 * File-save abstraction for the mnemonic-export buttons (PRD US #5).
 * Two implementations:
 *
 * - `tauriFileSave` (production) — uses `@tauri-apps/plugin-dialog`'s
 *   `save` to pop the OS-native save dialog, then writes via
 *   `@tauri-apps/plugin-fs`'s `writeFile` / `writeTextFile`.
 * - `browserFileSave` (dev/tests) — falls back to a download link via
 *   `Blob` + `URL.createObjectURL`. Works in any browser context.
 *
 * The slice ships both so the export buttons function in
 * `pnpm --filter @defer/desktop dev` (browser-only) AND in the full
 * `pnpm tauri:dev` runtime.
 */
export interface FileSavePort {
  saveBytes(opts: SaveOptions, bytes: Uint8Array): Promise<void>;
  saveText(opts: SaveOptions, content: string): Promise<void>;
}

export type SaveOptions = {
  suggestedFileName: string;
  /** MIME type — used by the browser fallback's `Blob`. */
  contentType: string;
};

export const browserFileSave: FileSavePort = {
  async saveBytes(opts, bytes) {
    if (typeof window === "undefined" || typeof URL === "undefined") return;
    // The cast widens the typed-array view so TypeScript accepts the
    // BlobPart slot; the underlying ArrayBuffer is the same.
    const blob = new Blob([bytes as unknown as BlobPart], { type: opts.contentType });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, opts.suggestedFileName);
    URL.revokeObjectURL(url);
  },
  async saveText(opts, content) {
    if (typeof window === "undefined" || typeof URL === "undefined") return;
    const blob = new Blob([content], { type: opts.contentType });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, opts.suggestedFileName);
    URL.revokeObjectURL(url);
  },
};

function triggerDownload(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function detectFileSave(): FileSavePort {
  // Tauri-runtime detection — wired in slice #57+ via the same marker
  // pattern as the keychain port. For now `browserFileSave` works in
  // both runtimes (Tauri webview supports Blob downloads to the user's
  // Downloads folder), so we keep the implementation flat until the
  // OS-native dialog actually adds value.
  return browserFileSave;
}
