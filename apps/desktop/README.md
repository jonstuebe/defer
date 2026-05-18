# @defer/desktop

The defer Tauri+React desktop app. Sync participant per the PRD; this slice (issue #45) ships the scaffold + the create-vault tracer (welcome → 3-screen onboarding → empty inbox → first save).

## Local development

```sh
# From the repo root:
pnpm install
# Frontend-only dev server (React, no Tauri shell):
pnpm --filter @defer/desktop dev
# Tauri desktop app (requires Rust toolchain installed):
pnpm --filter @defer/desktop tauri:dev
```

The Tauri shell is intentionally minimal in this slice — opening external URLs falls back to `window.open` until `@tauri-apps/plugin-shell` is wired in slice #46.

## CI

CI runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`. The Rust side (`src-tauri/`) is **not** compiled in CI; the desktop app's TypeScript surface is the only thing the CI build exercises. Rust changes are validated locally.

## What's in this slice (#45)

- Tauri+React scaffold with vite + vitest.
- `sqliteStorage` adapter via `sql.js` — items + events + settings tables; migration framework in place. FTS5 virtual table is deferred to slice #52 (sql.js's stock wasm build omits the extension).
- `vaultProjection` reactive store wrapping `@defer/core`'s pure reducer.
- `vaultCommands.save()` — canonicalizes via `@defer/core`, builds `ItemSaved`, projects locally, persists to events table, enqueues to `PendingEventQueue`.
- 3-screen onboarding: mnemonic display (with 60s clipboard auto-clear), mnemonic verification (4 random words by position, per PRD US #7), empty Inbox.
- Single-column Inbox list + paste-URL save bar. Click row opens URL.

## What's out of scope

- Outbound sync to the relay (slice #46).
- Inbound sync, cursor management, periodic pull (slice #47).
- 3-pane shell, detail pane, tags, archive/like/delete (#48–#50).
- Keyboard shortcuts, search, restoration, keychain, pairing, settings, deletion (later slices).
