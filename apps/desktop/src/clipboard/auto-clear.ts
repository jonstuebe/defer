export type ClipboardClearHandle = {
  cancel: () => void;
};

export type ClipboardDeps = {
  write: (text: string) => Promise<void>;
  setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
};

/**
 * Copy `text` to the clipboard and schedule overwrite to `""` after
 * `clearAfterMs` (default 60s, per PRD US #4). Returns a handle the caller
 * can `cancel()` to abort the scheduled clear — e.g., when the user
 * navigates away from the mnemonic screen, we cancel the timer because
 * the in-memory mnemonic itself is also dropped at that boundary.
 *
 * The auto-clear is best-effort — a backgrounded browser tab may throttle
 * the timer, and in the Tauri webview the OS clipboard can be overwritten
 * by other apps in the meantime. This is a usability gate, not a security
 * primitive; the mnemonic should be saved to PDF/keychain (slice #55) for
 * durability.
 */
export async function copyWithAutoClear(
  text: string,
  deps: ClipboardDeps,
  clearAfterMs: number = 60_000,
): Promise<ClipboardClearHandle> {
  await deps.write(text);
  const handle = deps.setTimer(() => {
    // Fire-and-forget — we don't await the clear write because nothing is
    // listening for it to complete, and a clipboard-permission failure
    // shouldn't crash a UI render that's already moved on.
    void deps.write("");
  }, clearAfterMs);
  return {
    cancel: () => deps.clearTimer(handle),
  };
}
