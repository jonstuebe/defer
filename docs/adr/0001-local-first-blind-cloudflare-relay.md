# Local-first architecture with a blind Cloudflare relay

Each device holds a full copy of the vault. A Cloudflare Worker + Durable Object relay stores only encrypted blobs keyed by an opaque vault ID — it never sees plaintext URLs, titles, or content. This was chosen over (a) a self-hosted single-user server, which would force users to maintain infrastructure, and (b) true peer-to-peer with CRDTs, which is structurally infeasible given that iOS Safari extension lifecycle + 80MB memory caps preclude running a peer-sync daemon there anyway.

"Bring your own relay" means deploying the same Worker source to your own Cloudflare account. We do **not** maintain a portable wire-protocol spec for other backends (Postgres, S3, self-hosted Node, etc.) — the protocol is allowed to lean on Cloudflare-specific primitives (Durable Objects for strict per-vault ordering, KV for short-lived pairing tokens, Workers Analytics, DO Hibernation for any future WebSocket push). This keeps v1 implementation effort honest at the cost of relay-backend portability, which we judge a fair trade because the BYO story is "deploy our Worker" rather than "implement our spec."

## Consequences

- The relay's API surface is allowed to be Cloudflare-shaped. A future "portable relay" effort would require either re-specifying the protocol or implementing a Cloudflare-compatible adapter.
- DO storage caps (10GB per DO) define the practical upper bound for a single vault. At ~500 bytes per event, this is effectively unlimited for a single user.
- The "blind" promise is not a property of Cloudflare's trustworthiness — it's an architectural property of the protocol. The relay literally never receives anything but ciphertext + opaque IDs.

See also: **ADR-0007** for the wire-level transport conventions (vault bootstrap, error envelope, CORS policy) that every relay endpoint inherits.
