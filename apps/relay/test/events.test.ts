import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, MAX_BATCH_SIZE } from "@defer/core/relay-protocol";

import type { Env } from "../src/env.js";

// Issue #26 acceptance: POST /events + GET /events on the per-vault Durable
// Object, with bearer auth, monotonic gap-free seq assignment, first-write
// self-registration, batch atomicity, replay protection, and the 410
// tombstone check on every endpoint. Tests cover all of ADR-0007 §1's
// unknown-vault table for these two routes plus ADR-0006 §4.2's relay-side
// replay rule.

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// --- fixtures -----------------------------------------------------------

const BASE = "https://relay.example.com";

// Per ADR-0006 §4.1: clientNonce is 22 base64url chars (16 bytes). We mint
// nonces by zero-padding an integer counter; each test gets a fresh counter
// via `nonceGen()` so cross-test bleed is impossible.
function nonceGen(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    // Pad to exactly 22 base64url chars. Using only `0-9` here keeps each
    // nonce trivially-readable in test output; the schema only requires
    // [A-Za-z0-9_-]{22}, so all-digit strings parse.
    const s = counter.toString();
    return s.padStart(22, "0");
  };
}

// Fresh vault id per test — 22-char base64url (16 random bytes), matching
// the production wire format (ADR-0007 §"vault id derivation" + the
// router-boundary VAULT_ID_REGEX in `relay-api.ts`). Using a fresh vault ID
// per test gives each test its own DO storage namespace, so we don't need
// to clear state between tests.
function freshVaultId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pendingItemSaved(args: {
  clientNonce: string;
  deviceId?: string;
  itemId?: string;
}): Record<string, unknown> {
  return {
    type: "ItemSaved",
    deviceId: args.deviceId ?? "device-test",
    timestamp: 1_700_000_000_000,
    clientNonce: args.clientNonce,
    data: {
      itemId: args.itemId ?? "item-1",
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

function pull(vaultId: string, token: string, since?: number): Promise<Response> {
  const q = since !== undefined ? `?since=${since}` : "";
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/events${q}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function setTombstone(vaultId: string): Promise<void> {
  // Reach into DO storage to flip the tombstone marker, simulating the
  // post-alarm "vault is gone" state. The actual alarm-fired deletion path
  // lands in issue #30; this is the only test-side affordance for forcing
  // the 410 path until then.
  const id = env.VAULT_RELAY.idFromName(vaultId);
  const stub = env.VAULT_RELAY.get(id);
  await runInDurableObject(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stub as any,
    async (_instance, state) => {
      await state.storage.put("meta:tombstone", true);
      // Also need to mark initialized so GET doesn't 404 before reaching the
      // tombstone check; for POST it doesn't matter because the tombstone
      // check is unconditional.
      await state.storage.put("meta:initialized", true);
    },
  );
}

// --- POST /events -------------------------------------------------------

describe("POST /v1/vault/:vaultId/events", () => {
  it("happy path single — assigns seq 1 and persists the envelope", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const response = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { assigned: number[] };
    expect(body.assigned).toEqual([1]);

    // Storage state: nextSeq advanced to 2; event:00..01 contains the stamped envelope.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    // `runInDurableObject` wants a `DurableObjectStub<VaultRelay>` rather than
    // the unparameterised stub the namespace `.get()` returns. The cast is a
    // typing-only narrowing; the runtime stub IS for VaultRelay.
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        const nextSeq = await state.storage.get<number>("meta:nextSeq");
        expect(nextSeq).toBe(2);
        const stored = await state.storage.get<{ seq: number; type: string }>(
          "event:0000000000000001",
        );
        expect(stored?.seq).toBe(1);
        expect(stored?.type).toBe("ItemSaved");
      },
    );
  });

  it("happy path batch — assigns sequential seqs in arrival order", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const response = await push(vaultId, "tok-1", [
      pendingItemSaved({ clientNonce: nonce() }),
      pendingItemSaved({ clientNonce: nonce() }),
      pendingItemSaved({ clientNonce: nonce() }),
    ]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { assigned: number[] };
    expect(body.assigned).toEqual([1, 2, 3]);
  });

  it("server is NOT idempotent: same payload, different clientNonces → distinct seqs", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const ev1 = pendingItemSaved({ clientNonce: nonce() });
    const ev2 = pendingItemSaved({ clientNonce: nonce() }); // same shape; new nonce
    const r1 = await push(vaultId, "tok-1", [ev1]);
    const r2 = await push(vaultId, "tok-1", [ev2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { assigned: number[] };
    const b2 = (await r2.json()) as { assigned: number[] };
    expect(b1.assigned).toEqual([1]);
    expect(b2.assigned).toEqual([2]);
  });

  it("replay protection: same (deviceId, clientNonce) twice → 409 DUPLICATE_CLIENT_NONCE", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const ev = pendingItemSaved({ clientNonce: nonce() });
    const r1 = await push(vaultId, "tok-1", [ev]);
    expect(r1.status).toBe(200);

    const r2 = await push(vaultId, "tok-1", [ev]);
    expect(r2.status).toBe(409);
    const env_ = ErrorEnvelopeSchema.parse(await r2.json());
    expect(env_.code).toBe("DUPLICATE_CLIENT_NONCE");
    expect(env_.details).toEqual({ eventIndex: 0 });

    // Storage state unchanged from the first POST.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    // `runInDurableObject` wants a `DurableObjectStub<VaultRelay>` rather than
    // the unparameterised stub the namespace `.get()` returns. The cast is a
    // typing-only narrowing; the runtime stub IS for VaultRelay.
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        const nextSeq = await state.storage.get<number>("meta:nextSeq");
        expect(nextSeq).toBe(2); // advanced once by the first POST, not by the replay
      },
    );
  });

  it("batch atomicity: duplicate clientNonce mid-batch → entire batch rejected with eventIndex", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const dup = pendingItemSaved({ clientNonce: nonce() });
    // First POST accepts `dup` so the second POST's mid-batch retry hits
    // pre-existing storage rather than the in-batch dedup map. Either path
    // is the same 409; this exercises the storage-hit branch.
    const r1 = await push(vaultId, "tok-1", [dup]);
    expect(r1.status).toBe(200);

    const fresh1 = pendingItemSaved({ clientNonce: nonce() });
    const fresh2 = pendingItemSaved({ clientNonce: nonce() });
    const r2 = await push(vaultId, "tok-1", [fresh1, dup, fresh2]);
    expect(r2.status).toBe(409);
    const env_ = ErrorEnvelopeSchema.parse(await r2.json());
    expect(env_.code).toBe("DUPLICATE_CLIENT_NONCE");
    expect(env_.details).toEqual({ eventIndex: 1 });

    // No partial writes — nextSeq still at 2 from the first POST, fresh1 and
    // fresh2 were NOT stored.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    // `runInDurableObject` wants a `DurableObjectStub<VaultRelay>` rather than
    // the unparameterised stub the namespace `.get()` returns. The cast is a
    // typing-only narrowing; the runtime stub IS for VaultRelay.
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        expect(await state.storage.get<number>("meta:nextSeq")).toBe(2);
        const list = await state.storage.list({ prefix: "event:" });
        expect(list.size).toBe(1);
      },
    );
  });

  it("oversized batch → 422 SCHEMA_VIOLATION", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const events = Array.from({ length: MAX_BATCH_SIZE + 1 }, () =>
      pendingItemSaved({ clientNonce: nonce() }),
    );
    const response = await push(vaultId, "tok-1", events);
    expect(response.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("empty batch → 422 SCHEMA_VIOLATION", async () => {
    const vaultId = freshVaultId();
    const response = await push(vaultId, "tok-1", []);
    expect(response.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("malformed envelope (missing clientNonce) → 422 SCHEMA_VIOLATION", async () => {
    const vaultId = freshVaultId();
    const event = pendingItemSaved({ clientNonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    delete (event as { clientNonce?: unknown }).clientNonce;
    const response = await push(vaultId, "tok-1", [event]);
    expect(response.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("missing bearer token → 401 INVALID_TOKEN", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const response = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [pendingItemSaved({ clientNonce: nonce() })] }),
    });
    expect(response.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("wrong bearer token (after vault is initialized) → 401 INVALID_TOKEN", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    // Initialize the vault with tok-1.
    const r1 = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r1.status).toBe(200);
    // tok-2 is not a registered token; gets 401.
    const r2 = await push(vaultId, "tok-2", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r2.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r2.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("first-write self-registration: fresh vault accepts first token, subsequent same-token POSTs succeed, different token rejected", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const r1 = await push(vaultId, "tok-first", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r1.status).toBe(200);

    // Token persisted — second POST with same token succeeds.
    const r2 = await push(vaultId, "tok-first", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r2.status).toBe(200);

    // Different token rejected.
    const r3 = await push(vaultId, "tok-second", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r3.status).toBe(401);
  });

  it("POST after tombstone → 410 VAULT_DELETED", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    await setTombstone(vaultId);
    const response = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(response.status).toBe(410);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("VAULT_DELETED");
  });
});

// --- GET /events --------------------------------------------------------

describe("GET /v1/vault/:vaultId/events", () => {
  it("empty initialized vault: GET ?since=0 → 200 with empty events and nextSince null", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    // Initialize via a single POST so the DO exists.
    const seed = await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(seed.status).toBe(200);

    const response = await pull(vaultId, "tok-1", 1);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: unknown[]; nextSince: number | null };
    expect(body.events).toEqual([]);
    expect(body.nextSince).toBeNull();
  });

  it("happy path: push 3, GET ?since=0 → all 3 in seq order (within page cap)", async () => {
    // Using `cap` events so this test exercises the "within page cap" path
    // independent of the page-cap override value. The vitest config pins the
    // cap at 3; choosing exactly `cap` events keeps `nextSince` null (the
    // server returns null iff fewer than `cap+1` events match the range).
    const cap = Number(env.MAX_PAGE_SIZE_OVERRIDE ?? "0");
    expect(cap).toBeGreaterThan(0);
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const evs = Array.from({ length: cap }, () => pendingItemSaved({ clientNonce: nonce() }));
    const seed = await push(vaultId, "tok-1", evs);
    expect(seed.status).toBe(200);

    const response = await pull(vaultId, "tok-1", 0);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      events: Array<{ seq: number }>;
      nextSince: number | null;
    };
    expect(body.events.map((e) => e.seq)).toEqual(Array.from({ length: cap }, (_, i) => i + 1));
    expect(body.nextSince).toBeNull();
  });

  it("since pagination: push 3, GET ?since=1 → events 2 and 3", async () => {
    const cap = Number(env.MAX_PAGE_SIZE_OVERRIDE ?? "0");
    expect(cap).toBeGreaterThanOrEqual(3);
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const evs = Array.from({ length: 3 }, () => pendingItemSaved({ clientNonce: nonce() }));
    await push(vaultId, "tok-1", evs);

    const response = await pull(vaultId, "tok-1", 1);
    const body = (await response.json()) as {
      events: Array<{ seq: number }>;
      nextSince: number | null;
    };
    expect(body.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(body.nextSince).toBeNull();
  });

  it("since beyond end: push 5, GET ?since=10 → empty events, nextSince null", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const evs = Array.from({ length: 5 }, () => pendingItemSaved({ clientNonce: nonce() }));
    await push(vaultId, "tok-1", evs);

    const response = await pull(vaultId, "tok-1", 10);
    const body = (await response.json()) as { events: unknown[]; nextSince: number | null };
    expect(body.events).toEqual([]);
    expect(body.nextSince).toBeNull();
  });

  it("page cap: with MAX_PAGE_SIZE_OVERRIDE=3, push 5 events → first GET returns 3 with nextSince=3; second GET completes the list", async () => {
    // Vitest pool sets MAX_PAGE_SIZE_OVERRIDE via the env override below
    // (see `bindings` in vitest.config.ts). Setting it inside the test via
    // miniflare's `setOptions` would also work but the config-level override
    // is simpler and applies uniformly. We assert here against whatever cap
    // is configured; in this repo it's 3.
    const cap = Number(env.MAX_PAGE_SIZE_OVERRIDE ?? "0");
    expect(cap).toBeGreaterThan(0);

    const nonce = nonceGen();
    const vaultId = freshVaultId();
    const evs = Array.from({ length: cap + 2 }, () => pendingItemSaved({ clientNonce: nonce() }));
    await push(vaultId, "tok-1", evs);

    const r1 = await pull(vaultId, "tok-1", 0);
    const b1 = (await r1.json()) as {
      events: Array<{ seq: number }>;
      nextSince: number | null;
    };
    expect(b1.events.length).toBe(cap);
    expect(b1.events.map((e) => e.seq)).toEqual(Array.from({ length: cap }, (_, i) => i + 1));
    expect(b1.nextSince).toBe(cap);

    const r2 = await pull(vaultId, "tok-1", cap);
    const b2 = (await r2.json()) as {
      events: Array<{ seq: number }>;
      nextSince: number | null;
    };
    expect(b2.events.map((e) => e.seq)).toEqual([cap + 1, cap + 2]);
    expect(b2.nextSince).toBeNull();
  });

  it("GET on unknown vault → 404 UNKNOWN_VAULT (no first-write on GET)", async () => {
    const vaultId = freshVaultId();
    const response = await pull(vaultId, "tok-1", 0);
    expect(response.status).toBe(404);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("UNKNOWN_VAULT");
  });

  it("missing bearer token → 401 INVALID_TOKEN", async () => {
    const vaultId = freshVaultId();
    const response = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/events?since=0`);
    expect(response.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("GET after tombstone → 410 VAULT_DELETED", async () => {
    const vaultId = freshVaultId();
    await setTombstone(vaultId);
    const response = await pull(vaultId, "tok-1", 0);
    expect(response.status).toBe(410);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("VAULT_DELETED");
  });

  it("malformed ?since (negative) → 422 SCHEMA_VIOLATION", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);
    const response = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/events?since=-1`, {
      headers: { Authorization: "Bearer tok-1" },
    });
    expect(response.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await response.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });
});

// --- concurrency --------------------------------------------------------

describe("POST /events — concurrent batches", () => {
  it("parallel POSTs see unique, monotonic seq across the union of both batches", async () => {
    const nonce = nonceGen();
    const vaultId = freshVaultId();
    // Seed so the vault is initialized; first-write only runs on the first
    // POST and we want both parallel POSTs to take the post-bootstrap path.
    await push(vaultId, "tok-1", [pendingItemSaved({ clientNonce: nonce() })]);

    const batchA = [
      pendingItemSaved({ clientNonce: nonce() }),
      pendingItemSaved({ clientNonce: nonce() }),
    ];
    const batchB = [
      pendingItemSaved({ clientNonce: nonce() }),
      pendingItemSaved({ clientNonce: nonce() }),
    ];
    const [rA, rB] = await Promise.all([
      push(vaultId, "tok-1", batchA),
      push(vaultId, "tok-1", batchB),
    ]);
    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);
    const bA = (await rA.json()) as { assigned: number[] };
    const bB = (await rB.json()) as { assigned: number[] };
    const union = new Set([...bA.assigned, ...bB.assigned]);
    expect(union.size).toBe(bA.assigned.length + bB.assigned.length);

    // Each batch's assignments are internally contiguous; the union spans
    // [2..5] (seq 1 is the seed). DO single-threadedness gives us this for
    // free — the test exists to lock the property in.
    const allSeqs = [...union].sort((a, b) => a - b);
    expect(allSeqs).toEqual([2, 3, 4, 5]);
  });
});
