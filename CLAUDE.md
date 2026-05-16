## Toolchain

- Lint with **oxlint** (`pnpm lint`) and format with **oxfmt** (`pnpm format` / `pnpm format:check`). Do not reach for ESLint or Prettier — they're intentionally not installed.
- Formatter config lives in `.oxfmtrc.json` (Prettier-shaped fields + `ignorePatterns`).
- Node version is pinned via `mise.toml`. pnpm is provisioned by **corepack** reading the `packageManager` field in `package.json` — run `corepack enable pnpm` once after cloning.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (uses `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
