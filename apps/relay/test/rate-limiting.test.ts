import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorEnvelopeSchema } from "@defer/core/relay-protocol";

import type { Env } from "../src/env.js";
import { __resetPairingFallback } from "../src/middleware/pairing-rate-limit.js";
import {
  EVENTS_BUCKET_CAPACITY,
  EVENTS_REFILL_PER_MIN,
  PAIRING_RATE_LIMIT_PER_MIN,
  REQUESTS_BUCKET_CAPACITY,
  REQUESTS_REFILL_PER_MIN,
  type TokenBucketState,
} from "../src/rate-limits.js";

// Issue #32 acceptance: per-vault token-bucket rate limiting in the
// `VaultRelay` DO (events + requests buckets) and a global Worker-tier limit
// on the pairing endpoints (keyed by `cf-connecting-ip`). Tests pin:
//
//   - Burst capacity for each per-vault bucket
//   - Cross-bucket semantics on POST /events (events AND requests both
//     consumed; either failing is a 429)
//   - Atomicity: when one of the two buckets fails on POST /events the
//     OTHER bucket is NOT decremented
//   - Bucket-state persistence across (simulated) DO eviction
//   - Health endpoint exemption
//   - Pairing endpoints' per-IP global cap
//   - Dispatch order: tombstone → rate-limit → auth
//
// The bucket capacities (600 events, 1200 requests, 60 pairing) are calibrated
// against the e2e demo harness (#31, ~5 requests total). Tests pre-seed
// bucket state via `runInDurableObject` rather than firing 600+ real
// requests; that keeps each case sub-second without losing coverage of the
// actual consume logic (the seam is the persisted shape, which the DO reads
// on the next request).

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE = "https://relay.example.com";

// --- shared fixtures ---------------------------------------------------

function freshVaultId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function nonceGen(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return counter.toString().padStart(22, "0");
  };
}

function pendingItemSaved(args: { clientNonce: string }): Record<string, unknown> {
  return {
    type: "ItemSaved",
    deviceId: "device-test",
    timestamp: 1_700_000_000_000,
    clientNonce: args.clientNonce,
    data: {
      itemId: "item-1",
      url: "https://example.com/article",
      canonicalUrl: "https://example.com/article",
      title: "An article",
      savedAt: 1_700_000_000_000,
    },
  };
}

function push(
  vaultId: string,
  token: string,
  events: Record<string, unknown>[],
): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ events }),
  });
}

function pull(vaultId: string, token: string, since = 0): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/events?since=${since}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Pre-seed bucket state. `lastRefillMs` is set to a comfortably-future
// timestamp so the consume-time refill (`elapsed = max(0, now - last)`) is
// always zero — the test sees EXACTLY the seeded tokens, no flaky drift
// from millisecond-granularity test scheduling.
const FUTURE_REFILL_WINDOW_MS = 10 * 60 * 1000;

async function seedBucket(
  vaultId: string,
  bucket: "events" | "requests",
  tokens: number,
): Promise<void> {
  const id = env.VAULT_RELAY.idFromName(vaultId);
  const stub = env.VAULT_RELAY.get(id);
  await runInDurableObject(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stub as any,
    async (_instance, state) => {
      const key = bucket === "events" ? "meta:rate:events" : "meta:rate:requests";
      const seed: TokenBucketState = {
        tokens,
        lastRefillMs: Date.now() + FUTURE_REFILL_WINDOW_MS,
      };
      await state.storage.put(key, seed);
    },
  );
}

async function readBucket(
  vaultId: string,
  bucket: "events" | "requests",
): Promise<TokenBucketState | undefined> {
  const id = env.VAULT_RELAY.idFromName(vaultId);
  const stub = env.VAULT_RELAY.get(id);
  let out: TokenBucketState | undefined;
  await runInDurableObject(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stub as any,
    async (_instance, state) => {
      const key = bucket === "events" ? "meta:rate:events" : "meta:rate:requests";
      out = await state.storage.get<TokenBucketState>(key);
    },
  );
  return out;
}

async function setTombstone(vaultId: string): Promise<void> {
  const id = env.VAULT_RELAY.idFromName(vaultId);
  const stub = env.VAULT_RELAY.get(id);
  await runInDurableObject(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stub as any,
    async (_instance, state) => {
      await state.storage.put("meta:tombstone", true);
      await state.storage.put("meta:initialized", true);
    },
  );
}

// --- per-vault: events bucket -------------------------------------------

describe("per-vault events bucket", () => {
  it("first burst within capacity all succeed; the one that drains to zero still succeeds; the next 429s", async () => {
    // Seed the events bucket to exactly 2 tokens. The requests bucket gets
    // full capacity (the seeded events bucket is the cap of interest here).
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    // Initialize the vault first so the bucket-state seeding survives the
    // bootstrap path's storage writes. (We can't seed before initialize
    // because the `put` is unconditional, but the bootstrap path doesn't
    // touch the bucket keys so seeding AFTER the first POST is the safer
    // ordering.)
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);

    // Seed events to 2 — the next two POSTs are allowed; the third 429s.
    await seedBucket(vaultId, "events", 2);
    // Also keep `requests` healthy so the failing bucket is unambiguously
    // `events`.
    await seedBucket(vaultId, "requests", 1000);

    const r1 = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r1.status).toBe(200);
    const r2 = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r2.status).toBe(200);

    const r3 = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).not.toBeNull();
    const retryAfterSec = Number(r3.headers.get("Retry-After"));
    expect(retryAfterSec).toBeGreaterThanOrEqual(1);

    const body = ErrorEnvelopeSchema.parse(await r3.json());
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.error).toBe("rate_limited");
    expect(body.details).toBeDefined();
    expect((body.details as Record<string, unknown> | undefined)?.bucket).toBe("events");
    expect((body.details as Record<string, unknown> | undefined)?.retryAfterMs).toEqual(
      expect.any(Number),
    );
  });

  it("a small burst exhausts a low-seeded events bucket and the next POST 429s; the OTHER bucket only decrements on POST", async () => {
    // The full 600-request burst is unworkable in CI: while the loop runs,
    // wall-clock time advances and the bucket refills (600/min = 10/sec).
    // We instead seed `events` to a small explicit count and verify exact
    // burst-and-deny semantics. This pins the cap-counting logic without
    // racing against the system clock.
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);

    await seedBucket(vaultId, "events", 3);
    await seedBucket(vaultId, "requests", 1000);

    for (let i = 0; i < 3; i++) {
      const r = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }

    const overflow = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(overflow.status).toBe(429);
    const body = ErrorEnvelopeSchema.parse(await overflow.json());
    expect(body.code).toBe("RATE_LIMITED");
    expect((body.details as Record<string, unknown> | undefined)?.bucket).toBe("events");
  });

  it("429 refills: after waiting Retry-After's worth of time, next POST succeeds", async () => {
    // We can't sleep through 60 seconds of refill in CI. Instead: drain the
    // bucket to 0, then rewind `lastRefillMs` by enough wall-clock ms that
    // the next consume sees a full token available. This exercises the same
    // codepath the production refill takes; the test seam is the persisted
    // bucket shape.
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);

    await seedBucket(vaultId, "events", 0);
    await seedBucket(vaultId, "requests", 1000);

    const blocked = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(blocked.status).toBe(429);
    await blocked.arrayBuffer();

    // Rewind lastRefillMs into the past so > 1 token has accrued by `now`.
    // The seed put `lastRefillMs` in the future; flipping it to "now -
    // refillForOneToken - 50ms" gives the consume code a clean refill of
    // ~1.0+ tokens.
    const refillRatePerMs = EVENTS_REFILL_PER_MIN / 60_000;
    const needMs = Math.ceil(1 / refillRatePerMs) + 50;
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        await state.storage.put("meta:rate:events", {
          tokens: 0,
          lastRefillMs: Date.now() - needMs,
        } satisfies TokenBucketState);
      },
    );

    const refilled = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(refilled.status).toBe(200);
  });

  it("emits structured log line tagged with rateLimit.bucket = events on 429", async () => {
    const logSpy = vi.spyOn(console, "log");
    try {
      const nonce = nonceGen();
      const vaultId = freshVaultId();
      const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
      expect(seed.status).toBe(200);
      await seedBucket(vaultId, "events", 0);
      await seedBucket(vaultId, "requests", 1000);

      const blocked = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
      expect(blocked.status).toBe(429);
      await blocked.arrayBuffer();

      // Find the JSON log line for this 429.
      let found: Record<string, unknown> | null = null;
      for (const call of logSpy.mock.calls) {
        const arg = call[0];
        if (typeof arg !== "string" || !arg.startsWith("{")) continue;
        const parsed = JSON.parse(arg) as Record<string, unknown>;
        if (parsed.status === 429 && parsed.rateLimit !== undefined) {
          found = parsed;
          break;
        }
      }
      expect(found).not.toBeNull();
      const rl = found!.rateLimit as Record<string, unknown>;
      expect(rl.bucket).toBe("events");
      expect(rl.retryAfterMs).toEqual(expect.any(Number));
      // vaultIdHash is present (path matched /v1/vault/:vaultId/...).
      expect(typeof found!.vaultIdHash).toBe("string");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// --- per-vault: requests bucket ------------------------------------------

describe("per-vault requests bucket", () => {
  it("GETs only consume requests bucket; events bucket untouched", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);
    // After bootstrap: events bucket has CAPACITY-1 left (we consumed 1 on
    // the POST). Read the live tokens count and stash it.
    const eventsBefore = await readBucket(vaultId, "events");
    expect(eventsBefore).toBeDefined();

    // Seed `requests` to exactly 1 — one pull succeeds, the second 429s.
    // (Seeding to 2+ races against wall-clock refill: at 1200/min the
    // bucket regenerates a full token every ~50ms, and consecutive pulls
    // in CI take longer than that.)
    await seedBucket(vaultId, "requests", 1);
    const r1 = await pull(vaultId, "tok-1", 0);
    expect(r1.status).toBe(200);
    await r1.arrayBuffer();

    // Re-seed to 0 to bypass any wall-clock refill drift between consume
    // and the next request.
    await seedBucket(vaultId, "requests", 0);
    const r2 = await pull(vaultId, "tok-1", 0);
    expect(r2.status).toBe(429);
    const body = ErrorEnvelopeSchema.parse(await r2.json());
    expect((body.details as Record<string, unknown> | undefined)?.bucket).toBe("requests");
    expect(r2.headers.get("Retry-After")).not.toBeNull();

    // events bucket must not have moved as a result of the GETs.
    const eventsAfter = await readBucket(vaultId, "events");
    expect(eventsAfter?.tokens).toBeCloseTo(eventsBefore!.tokens, 6);
  });

  it("cross-bucket: exhausted requests bucket blocks subsequent POST /events too", async () => {
    // Documents the issue's pinned cross-bucket decision: a pull-storm that
    // drains `requests` also blocks subsequent writes (POST /events consumes
    // both buckets and the requests-bucket failure path 429s the write).
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);

    await seedBucket(vaultId, "events", 1000);
    await seedBucket(vaultId, "requests", 0);

    const blocked = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(blocked.status).toBe(429);
    const body = ErrorEnvelopeSchema.parse(await blocked.json());
    expect((body.details as Record<string, unknown> | undefined)?.bucket).toBe("requests");
  });
});

// --- cross-bucket atomicity ---------------------------------------------

describe("cross-bucket atomicity on POST /events", () => {
  it("when requests bucket fails, events bucket is NOT decremented", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);

    // events = 1 (enough for one more POST), requests = 0 (blocks).
    await seedBucket(vaultId, "events", 1);
    await seedBucket(vaultId, "requests", 0);

    const blocked = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(blocked.status).toBe(429);
    const body = ErrorEnvelopeSchema.parse(await blocked.json());
    expect((body.details as Record<string, unknown> | undefined)?.bucket).toBe("requests");

    // events bucket still at 1 — no half-write.
    const events = await readBucket(vaultId, "events");
    expect(events?.tokens).toBe(1);
  });

  it("when events bucket fails, requests bucket is NOT decremented", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);

    await seedBucket(vaultId, "events", 0);
    await seedBucket(vaultId, "requests", 5);

    const blocked = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(blocked.status).toBe(429);
    const body = ErrorEnvelopeSchema.parse(await blocked.json());
    expect((body.details as Record<string, unknown> | undefined)?.bucket).toBe("events");

    const requests = await readBucket(vaultId, "requests");
    expect(requests?.tokens).toBe(5);
  });
});

// --- health endpoint exempt ---------------------------------------------

describe("health endpoint exempt from rate limiting", () => {
  it("many GET /v1/health requests in a row all succeed regardless of bucket state", async () => {
    // Run a tight burst; well above any per-IP/per-vault cap.
    for (let i = 0; i < 200; i++) {
      const r = await SELF.fetch(`${BASE}/v1/health`);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
  }, 20_000);
});

// --- pairing endpoints --------------------------------------------------

describe("pairing-endpoint global rate limit", () => {
  beforeEach(() => {
    // Reset the in-memory fallback bucket map between cases so per-IP
    // counters don't bleed across tests.
    __resetPairingFallback();
  });

  function freshPairingToken(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Helper: hammer the pairing endpoint until a 429 is observed (or we
  // give up after `maxAttempts`). The fallback path's wall-clock refill
  // means a tight ~60-request loop may finish with a couple of tokens
  // still in the bucket; a small over-burst settles it deterministically.
  async function pairFloodUntil429(
    ip: string,
    maxAttempts: number,
  ): Promise<{ successes: number; first429: Response | null }> {
    let successes = 0;
    for (let i = 0; i < maxAttempts; i++) {
      const r = await SELF.fetch(`${BASE}/v1/pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({
          pairingToken: freshPairingToken(),
          sealedPayload: btoa("hello"),
        }),
      });
      if (r.status === 429) {
        return { successes, first429: r };
      }
      expect(r.status).toBe(204);
      await r.arrayBuffer();
      successes++;
    }
    return { successes, first429: null };
  }

  it(`burst from one IP eventually 429s with Retry-After once the per-IP cap is reached`, async () => {
    // Note: the fallback path leaks 1 token / second of refill, so the
    // *exact* boundary is hard to pin in a clock-coupled test. We over-
    // burst (cap * 2) and assert that:
    //   - At least `PAIRING_RATE_LIMIT_PER_MIN` requests succeeded before
    //     the first 429 (the configured steady-state isn't tighter than
    //     advertised).
    //   - A 429 eventually surfaces with the canonical envelope + header.
    const ip = "203.0.113.10";
    const { successes, first429 } = await pairFloodUntil429(ip, PAIRING_RATE_LIMIT_PER_MIN * 2);
    expect(first429).not.toBeNull();
    expect(successes).toBeGreaterThanOrEqual(PAIRING_RATE_LIMIT_PER_MIN);

    const ra = first429!.headers.get("Retry-After");
    expect(ra).not.toBeNull();
    expect(Number(ra)).toBeGreaterThanOrEqual(1);
    const body = ErrorEnvelopeSchema.parse(await first429!.json());
    expect(body.code).toBe("RATE_LIMITED");
    expect((body.details as Record<string, unknown> | undefined)?.bucket).toBe("pairing");
  }, 30_000);

  it("different IPs do NOT share the bucket", async () => {
    const ipA = "203.0.113.20";
    const ipB = "203.0.113.21";
    // Hammer A until 429.
    const { first429 } = await pairFloodUntil429(ipA, PAIRING_RATE_LIMIT_PER_MIN * 2);
    expect(first429).not.toBeNull();
    await first429!.arrayBuffer();

    // B is fresh — at least one request must succeed.
    const ok = await SELF.fetch(`${BASE}/v1/pairing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": ipB },
      body: JSON.stringify({
        pairingToken: freshPairingToken(),
        sealedPayload: btoa("hello"),
      }),
    });
    expect(ok.status).toBe(204);
  }, 30_000);

  it("emits structured log with clientIpHash (not raw IP) on pairing 429", async () => {
    const ip = "203.0.113.42";
    const logSpy = vi.spyOn(console, "log");
    try {
      const { first429 } = await pairFloodUntil429(ip, PAIRING_RATE_LIMIT_PER_MIN * 2);
      expect(first429).not.toBeNull();
      await first429!.arrayBuffer();

      let found: Record<string, unknown> | null = null;
      for (const call of logSpy.mock.calls) {
        const arg = call[0];
        if (typeof arg !== "string" || !arg.startsWith("{")) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(arg) as Record<string, unknown>;
        } catch {
          continue;
        }
        const rl = parsed.rateLimit as Record<string, unknown> | undefined;
        if (parsed.status === 429 && rl?.bucket === "pairing") {
          found = parsed;
        }
        // Defensive: never log the raw IP, on any line.
        expect(arg.includes(ip)).toBe(false);
      }
      expect(found).not.toBeNull();
      const rl = found!.rateLimit as Record<string, unknown>;
      expect(rl.bucket).toBe("pairing");
      expect(typeof rl.clientIpHash).toBe("string");
      expect(rl.clientIpHash).not.toBe(ip);
    } finally {
      logSpy.mockRestore();
    }
  }, 30_000);
});

// --- dispatch order: tombstone → rate-limit → auth -----------------------

describe("dispatch order", () => {
  it("tombstone fires BEFORE rate-limit: dead vault always returns 410, never 429", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    await setTombstone(vaultId);
    // Exhaust buckets via seeding so a request would otherwise 429.
    await seedBucket(vaultId, "events", 0);
    await seedBucket(vaultId, "requests", 0);

    const r = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r.status).toBe(410);
    const body = ErrorEnvelopeSchema.parse(await r.json());
    expect(body.code).toBe("VAULT_DELETED");
  });

  it("rate-limit fires BEFORE auth: anonymous request with empty buckets returns 429, not 401", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    // Bootstrap with a real token first, then drain buckets.
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);
    await seedBucket(vaultId, "events", 0);
    await seedBucket(vaultId, "requests", 0);

    // No Authorization header at all — would normally 401 INVALID_TOKEN.
    const r = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: [pendingItemSaved({ clientNonce: nonce() })],
      }),
    });
    expect(r.status).toBe(429);
    const body = ErrorEnvelopeSchema.parse(await r.json());
    expect(body.code).toBe("RATE_LIMITED");
  });
});

// --- persistence across (simulated) eviction -----------------------------

describe("bucket state survives DO eviction", () => {
  it("seeded bucket state persists through a stub re-resolve", async () => {
    // Cloudflare's vitest pool doesn't expose a real `evict()` primitive,
    // but every fresh `env.VAULT_RELAY.get(id)` round-trips through the
    // persistent storage. We simulate eviction by seeding state, fetching
    // the bucket value back via a new stub-resolution, and asserting the
    // tokens count matches the seed (i.e. it was persisted, not just held
    // in an in-memory variable on the prior instance).
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);
    await seedBucket(vaultId, "events", 0);

    // Re-resolve the stub fresh (simulates a cold DO restart — even if the
    // pool keeps the isolate warm, the storage layer is the same one
    // production uses).
    const persisted = await readBucket(vaultId, "events");
    expect(persisted).toBeDefined();
    expect(persisted!.tokens).toBe(0);

    // A subsequent POST sees the depleted state and 429s (unless the elapsed
    // refill since seeding was enough to mint a token; the seeding sets
    // lastRefillMs to "now", so the elapsed delta is near zero).
    const blocked = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(blocked.status).toBe(429);
  });
});

// --- sanity: defaults exercised by the calibration calculation ----------

describe("calibration sanity", () => {
  it("constants match the documented values (changes here ARE protocol bumps)", () => {
    expect(EVENTS_BUCKET_CAPACITY).toBe(600);
    expect(EVENTS_REFILL_PER_MIN).toBe(600);
    expect(REQUESTS_BUCKET_CAPACITY).toBe(1200);
    expect(REQUESTS_REFILL_PER_MIN).toBe(1200);
    expect(PAIRING_RATE_LIMIT_PER_MIN).toBe(60);
  });
});

// `afterEach` is defined at the describe-block level above for pairing; the
// final top-level afterEach below provides a safety net for any other test
// that incidentally touched the in-memory fallback map.
afterEach(() => {
  __resetPairingFallback();
});
