# Defer

A local-first **read-later queue** in the shape of Instapaper. Items flow through states (Inbox → Archive), with optional tags for topic organization. Each user owns their own dataset; devices sync end-to-end encrypted blobs through a blind relay.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jonstuebe/defer/tree/main/apps/relay)

Run your own blind relay on Cloudflare in one click. See [`apps/relay/README.md`](apps/relay/README.md) for the BYO walkthrough.

## Status

**Pre-build.** The v1 spec is written (see `CONTEXT.md` and `docs/adr/`) and the pnpm workspace is scaffolded with an empty `@defer/core` package, but no apps, relay, or working features exist yet. Nothing here is runnable end-to-end.

## Getting started

Node is pinned via [mise](https://mise.jdx.dev/) (`mise.toml`). pnpm is provisioned by corepack via the `packageManager` field in `package.json`.

```sh
mise install            # install pinned Node
corepack enable pnpm    # one-time: register the pnpm shim
pnpm install
```

## Further reading

- `CONTEXT.md` — domain language and v1 event catalog
- `docs/adr/` — architectural decisions (local-first relay, event-log sync, crypto baseline, monorepo layout, vault deletion)
- `CLAUDE.md` — toolchain and agent skill pointers
