# pnpm monorepo with a shared TypeScript core

Single pnpm monorepo. The expensive parts of the codebase — sync engine, crypto, event types, data model, canonical URL normalization — live in `@defer/core` (TypeScript) and are consumed by every surface.

Repository layout:

```
defer/
├── packages/
│   └── core/                          # @defer/core: sync engine, crypto, events
├── apps/
│   ├── relay/                         # Cloudflare Worker + Durable Object
│   ├── desktop/                       # Tauri (Mac/Windows/Linux)
│   ├── mobile/                        # RN + Expo (iOS now, Android later)
│   │                                  # includes the iOS Share Extension
│   ├── extension-chrome/              # Chrome MV3 Web Extension
│   └── extension-safari/              # Safari Web Extension (macOS only)
```

**Apps** are sync participants: full SQLite + FTS5, replay the event log, render the full UI. **Extensions and the iOS Share Extension** are thin senders: maintain only a small local cache (recent tags used here + pending events queue), no sync replay, no search index.

## Considered and rejected

- **Native SwiftUI for iOS/macOS.** Rejected for v1. The expensive code (crypto, sync engine, event reducer) already lives in TypeScript; rewriting it twice in Swift gives no UX win that justifies the cost for a solo project. SwiftUI remains a credible v2 path: it would consume `@defer/core` via a Rust-port bridge (UniFFI), or accept the duplication.
- **React Native macOS instead of Tauri.** Rejected. RN macOS is a quieter ecosystem and Tauri is the path of least resistance for a Mac/Windows/Linux desktop app — no App Store, no provisioning, no native dev setup beyond Rust toolchain.
- **All-web (PWA + extensions everywhere).** Rejected. iOS PWA experience is meaningfully worse than native (no real share sheet integration, no Keychain, awkward "Add to Home Screen" onboarding). The iOS Share Extension is load-bearing for the iOS save flow and can't be replaced with a PWA.

## Consequences

- iOS Safari Web Extension is **not** built in v1. The 80MB process memory cap, content-script per-origin gating, and aggressive lifecycle make it infeasible for the sync model. The iOS Share Extension is the canonical iOS save path.
- The `@defer/core` API is a load-bearing contract. Anything in core must work in three runtimes: Cloudflare Worker (V8, WebCrypto), Hermes (RN), and Chrome/Safari extension contexts (V8, WebCrypto + libsodium-wasm).
- pnpm workspaces are the package manager. `pnpm-workspace.yaml` defines `packages/*` and `apps/*`.
