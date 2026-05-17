// Per-vault rate-limiting constants (issue #32). Two independent token buckets
// per vault, persisted in DO storage so they survive eviction:
//
//   - `events`   — writes only (POST /events). Bounds the cost of a runaway
//                  thin-sender or a malicious POST loop.
//   - `requests` — every authenticated vault-scoped endpoint. Bounds the cost
//                  of pull-storms and pairing-poll abuse.
//
// Token bucket model (O(1) per request, burst-friendly):
//
//   - `capacity`         — burst headroom (the bucket holds up to this many tokens)
//   - `refillPerMinute`  — steady-state replenishment rate
//   - On each request, the bucket is refilled by `(now - lastRefill) * rate`
//     up to `capacity`, then one token is consumed. If the post-refill total
//     is < 1, the request is rate-limited and the response carries
//     `Retry-After` computed from the deficit.
//
// Calibration: the e2e demo harness (#31) issues ~5 requests total; these
// caps sit ~100× above realistic happy-path traffic, well under any threshold
// a healthy client would hit. Real tuning happens post-launch with metrics;
// see `apps/relay/README.md` §"Rate limiting".

/** Maximum tokens the events bucket can hold (burst capacity). */
export const EVENTS_BUCKET_CAPACITY = 600;

/** Events bucket refill rate, in tokens per minute (steady-state). */
export const EVENTS_REFILL_PER_MIN = 600;

/** Maximum tokens the requests bucket can hold (burst capacity). */
export const REQUESTS_BUCKET_CAPACITY = 1200;

/** Requests bucket refill rate, in tokens per minute (steady-state). */
export const REQUESTS_REFILL_PER_MIN = 1200;

/**
 * Pairing-endpoint global rate limit. Applies to `POST /v1/pairing` and
 * `GET /v1/pairing/:token`, keyed by `cf-connecting-ip`. These endpoints have
 * no `vaultId` so the per-vault buckets don't apply; we still need a cap so
 * pairing-poll abuse can't be used as a free relay-side blob store probe.
 */
export const PAIRING_RATE_LIMIT_PER_MIN = 60;
export const PAIRING_RATE_LIMIT_PERIOD_SECONDS = 60;

/** Per-bucket persistent state. */
export interface TokenBucketState {
  /** Current token count (fractional permitted). */
  tokens: number;
  /** Wall-clock ms timestamp of the last refill. */
  lastRefillMs: number;
}

/**
 * Token-bucket consume outcome. When `allowed`, the caller is expected to
 * persist `newTokens` / `newLastRefillMs` back to storage. When denied,
 * `retryAfterMs` is the milliseconds until a single token will be available.
 */
export type ConsumeOutcome =
  | { allowed: true; newTokens: number; newLastRefillMs: number }
  | { allowed: false; retryAfterMs: number };

/**
 * Pure token-bucket consume helper. Refills the bucket based on elapsed time
 * since `lastRefillMs`, capped at `capacity`, then attempts to consume one
 * token. No I/O; the caller persists the new state if `allowed === true`.
 *
 * `refillPerMin` is the steady-state replenishment rate; the function does
 * the per-ms conversion internally so call sites don't sprinkle 60_000s
 * everywhere.
 */
export function consumeOne(
  state: TokenBucketState | undefined,
  capacity: number,
  refillPerMin: number,
  now: number,
): ConsumeOutcome {
  const refillPerMs = refillPerMin / 60_000;
  // Fresh bucket: full capacity, last-refilled "now". This makes the very
  // first request feel snappy (no synthetic warm-up delay) and means the
  // post-eviction restore can lazily reconstruct a missing bucket without
  // surprising the client.
  const current: TokenBucketState =
    state !== undefined ? state : { tokens: capacity, lastRefillMs: now };
  const elapsed = Math.max(0, now - current.lastRefillMs);
  const refilled = Math.min(capacity, current.tokens + elapsed * refillPerMs);
  if (refilled >= 1) {
    return { allowed: true, newTokens: refilled - 1, newLastRefillMs: now };
  }
  const tokensNeeded = 1 - refilled;
  // Ceil so the client waits at least until a whole token has accrued. A
  // client that polls exactly at `now + retryAfterMs` should succeed.
  const retryAfterMs = Math.max(1, Math.ceil(tokensNeeded / refillPerMs));
  return { allowed: false, retryAfterMs };
}
