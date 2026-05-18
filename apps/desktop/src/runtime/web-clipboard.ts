import type { ClipboardDeps } from "../clipboard/auto-clear.js";

/**
 * Production clipboard deps bound to the browser's `navigator.clipboard`
 * and `setTimeout`. Tests inject a fake-deps object directly into
 * `copyWithAutoClear`.
 */
export const webClipboardDeps: ClipboardDeps = {
  async write(text: string): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  },
  setTimer(handler, ms) {
    return setTimeout(handler, ms);
  },
  clearTimer(handle) {
    clearTimeout(handle);
  },
};
