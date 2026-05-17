/**
 * Opens a URL in the user's default browser.
 *
 * Tauri v2 (slice ships in #46 once the shell plugin lands as a dep): use
 * `@tauri-apps/plugin-shell` `open(url)`. Until then we fall back to
 * `window.open(url, "_blank")` which the Tauri webview intercepts via
 * `tauri.conf.json`'s `app.windows[].withGlobalTauri = false` + a navigate
 * handler. For browser dev (vite serve) this opens a new tab.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  // Non-browser environment (tests, SSR) — no-op rather than throw so the
  // caller doesn't have to special-case it.
}
