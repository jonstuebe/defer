/**
 * Optional system-keychain integration (PRD US #6). The keychain is an
 * **explicitly non-authoritative** convenience copy — the user's typed
 * mnemonic is the source of truth, not whatever the OS keychain holds.
 *
 * Implementations:
 * - `tauriKeychain` (slice #55 production path) — calls into the Tauri
 *   `keyring` crate via `tauri-plugin-keyring` invocations. The actual
 *   wiring lives in `src-tauri/src/lib.rs`; this file only declares the
 *   port + the fallback for non-Tauri runtimes.
 * - `noopKeychain` (browser dev, Node tests) — every call is a no-op
 *   that resolves silently. Keeps the UI flow unbreakable on systems
 *   without a keychain backend.
 *
 * The "service" namespace is fixed at `defer-vault-mnemonic` and the
 * key is the vault-id-short prefix, so multiple vaults coexist cleanly
 * in the same user's keychain.
 */
export interface KeychainPort {
  save(account: string, value: string): Promise<void>;
  load(account: string): Promise<string | null>;
  remove(account: string): Promise<void>;
  /** Reports whether this implementation actually persists; UI hides the option when false. */
  isAvailable(): boolean;
}

export const noopKeychain: KeychainPort = {
  async save() {},
  async load() {
    return null;
  },
  async remove() {},
  isAvailable() {
    return false;
  },
};

/**
 * Returns the Tauri-backed keychain when running inside the Tauri
 * webview, otherwise the no-op stub.
 *
 * Detection: `window.__TAURI_INTERNALS__` is the v2 marker injected by
 * the Tauri shell. Older code uses `window.__TAURI__`; v2 webviews
 * expose both, but `__TAURI_INTERNALS__` is the canonical one.
 */
export function detectKeychain(): KeychainPort {
  if (
    typeof window !== "undefined" &&
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  ) {
    return tauriKeychain;
  }
  return noopKeychain;
}

const SERVICE = "defer-vault-mnemonic";

const tauriKeychain: KeychainPort = {
  async save(account, value) {
    const invoke = await loadInvoke();
    await invoke("plugin:keyring|save", { service: SERVICE, account, value });
  },
  async load(account) {
    const invoke = await loadInvoke();
    const result = await invoke<string | null>("plugin:keyring|load", {
      service: SERVICE,
      account,
    });
    return result ?? null;
  },
  async remove(account) {
    const invoke = await loadInvoke();
    await invoke("plugin:keyring|remove", { service: SERVICE, account });
  },
  isAvailable() {
    return true;
  },
};

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function loadInvoke(): Promise<InvokeFn> {
  // Dynamic import so non-Tauri runtimes never try to evaluate the
  // module (it pulls in transitive Tauri runtime helpers).
  const mod = (await import("@tauri-apps/api/core")) as { invoke: InvokeFn };
  return mod.invoke;
}
