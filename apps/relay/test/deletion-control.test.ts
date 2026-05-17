import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "@defer/core/relay-protocol";
import { RELAY_DEVICE_ID } from "@defer/core";

import type { Env } from "../src/env.js";

// Issue #29 acceptance: POST /schedule-deletion and POST /cancel-deletion on
// the per-vault DO. The data plane (alarm fire → VaultDeleted emission →
// state.storage.deleteAll() tombstone) lives in #30; these tests cover only
// the control plane (arm + disarm + event-log append + alarm bookkeeping).

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE = "https://relay.example.com";

// 22-char base64url placeholder for envelope clientNonce + bootstrap token
// values. Tests use distinct counters so cross-test bleed is impossible.
function nonceGen(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return counter.toString().padStart(22, "0");
  };
}

function freshVaultId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 43-char base64url placeholder for the HMAC-SHA256 signature. The relay does
// not verify signatures (ADR-0001 blind-relay invariant); it only enforces the
// wire-format regex (43 base64url chars). Any string of the right shape parses.
const SIG = "A".repeat(43);

interface PendingItemSavedArgs {
  clientNonce: string;
  deviceId?: string;
}

function pendingItemSaved(args: PendingItemSavedArgs): Record<string, unknown> {
  return {
    type: "ItemSaved",
    deviceId: args.deviceId ?? "device-boot",
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

function pull(vaultId: string, token: string, since: number): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/events?since=${since}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function scheduleDeletion(vaultId: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/schedule-deletion`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function cancelDeletion(vaultId: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/cancel-deletion`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function setTombstone(vaultId: string): Promise<void> {
  // Reach into DO storage to flip the tombstone marker, simulating the
  // post-alarm "vault is gone" state — #30 fires the alarm for real; we just
  // poke the flag here.
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

async function bootstrapVault(vaultId: string, token: string): Promise<void> {
  // First-write self-registers `token` as the bootstrap device-auth-token.
  // Use a distinctive clientNonce ("bootstrap-...") so per-test nonce counters
  // (which start at 1) don't collide with the bootstrap event's nonce.
  const r = await push(vaultId, token, [
    pendingItemSaved({
      clientNonce: "bootstrap-".padEnd(22, "A").slice(0, 22),
      deviceId: "device-boot",
    }),
  ]);
  expect(r.status).toBe(200);
}

interface ScheduleEnvelopes {
  scheduled: Record<string, unknown>;
  deleted: Record<string, unknown>;
  scheduledFor: number;
}

function makeSchedulePair(args: {
  scheduledFor?: number;
  deviceId?: string;
  scheduledNonce: string;
  deletedNonce: string;
  scheduledSig?: string;
  deletedSig?: string;
  deletedDeviceId?: string;
  deletedAtOverride?: number;
}): ScheduleEnvelopes {
  const scheduledFor = args.scheduledFor ?? Date.now() + 48 * 60 * 60 * 1000;
  const deletedAt = args.deletedAtOverride ?? scheduledFor;
  return {
    scheduledFor,
    scheduled: {
      type: "VaultDeletionScheduled",
      deviceId: args.deviceId ?? "device-boot",
      timestamp: Date.now(),
      clientNonce: args.scheduledNonce,
      signature: args.scheduledSig ?? SIG,
      data: { scheduledFor },
    },
    deleted: {
      type: "VaultDeleted",
      deviceId: args.deletedDeviceId ?? RELAY_DEVICE_ID,
      timestamp: Date.now(),
      clientNonce: args.deletedNonce,
      signature: args.deletedSig ?? SIG,
      data: { deletedAt },
    },
  };
}

function makeCancel(args: {
  deviceId?: string;
  clientNonce: string;
  sig?: string;
}): Record<string, unknown> {
  return {
    type: "VaultDeletionCancelled",
    deviceId: args.deviceId ?? "device-boot",
    timestamp: Date.now(),
    clientNonce: args.clientNonce,
    signature: args.sig ?? SIG,
    data: {},
  };
}

// --- POST /schedule-deletion --------------------------------------------

describe("POST /v1/vault/:vaultId/schedule-deletion", () => {
  it("happy path → 200, events appear on GET, pending blob set, alarm scheduled", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r = await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { scheduledFor: number; assignedSeq: number };
    expect(body.scheduledFor).toBe(pair.scheduledFor);
    expect(body.assignedSeq).toBe(2); // 1 is the bootstrap event

    // GET /events surfaces the scheduled envelope.
    const get = await pull(vaultId, token, 0);
    const getBody = (await get.json()) as {
      events: Array<{ seq: number; type: string; data: Record<string, unknown> }>;
    };
    expect(getBody.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "ItemSaved"],
      [2, "VaultDeletionScheduled"],
    ]);
    expect(getBody.events[1]?.data.scheduledFor).toBe(pair.scheduledFor);

    // DO storage — pending blob set + alarm armed.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        const pending = await state.storage.get<{ type: string }>("meta:pendingVaultDeleted");
        expect(pending?.type).toBe("VaultDeleted");
        const scheduledFor = await state.storage.get<number>("meta:scheduledFor");
        expect(scheduledFor).toBe(pair.scheduledFor);
        const alarm = await state.storage.getAlarm();
        expect(alarm).toBe(pair.scheduledFor);
      },
    );
  });

  it("mismatched deletedAt vs scheduledFor → 422 with deletedAt_mismatch", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const scheduledFor = Date.now() + 48 * 60 * 60 * 1000;
    const pair = makeSchedulePair({
      scheduledFor,
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
      deletedAtOverride: scheduledFor + 1, // off-by-one mismatch
    });
    const r = await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
    expect(env_.details?.reason).toBe("deletedAt_mismatch");
  });

  it("wrong deleted.deviceId (not RELAY_DEVICE_ID) → 422", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
      deletedDeviceId: "some-real-device",
    });
    const r = await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
    expect(env_.details?.reason).toBe("deleted_deviceId_not_relay");
  });

  it("malformed signature (42 chars instead of 43) → 422", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
      scheduledSig: "A".repeat(42),
    });
    const r = await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("scheduledFor in the past (1 minute, well outside skew) — wait, skew is 5min so 1min is INSIDE skew. Use -10 minutes.", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledFor: Date.now() - 10 * 60 * 1000,
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r = await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
    expect(env_.details?.reason).toBe("scheduled_in_past");
  });

  it("scheduledFor 3 minutes in the past — inside the 5-minute skew tolerance → 200", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledFor: Date.now() - 3 * 60 * 1000,
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r = await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(200);

    // The skew window deliberately permits a past `scheduledFor`, which means
    // `state.storage.setAlarm()` is called with a time already elapsed. In
    // miniflare that fires the alarm immediately on the next tick. The alarm
    // handler is a no-op in this PR (#30 wires up the real wipe), but the
    // alarm-fire-during-test-teardown can race with vitest-pool-workers'
    // isolated-storage cleanup. Cancel the alarm explicitly so the DO is
    // quiescent when the test finishes.
    const cancelled = makeCancel({ clientNonce: nonce() });
    const c = await cancelDeletion(vaultId, token, { cancelled });
    expect(c.status).toBe(200);
  });

  it("already-scheduled → 409 DELETION_ALREADY_SCHEDULED", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair1 = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r1 = await scheduleDeletion(vaultId, token, {
      scheduled: pair1.scheduled,
      deleted: pair1.deleted,
    });
    expect(r1.status).toBe(200);

    const pair2 = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r2 = await scheduleDeletion(vaultId, token, {
      scheduled: pair2.scheduled,
      deleted: pair2.deleted,
    });
    expect(r2.status).toBe(409);
    const env_ = ErrorEnvelopeSchema.parse(await r2.json());
    expect(env_.code).toBe("DELETION_ALREADY_SCHEDULED");
  });

  it("tombstoned vault → 410 VAULT_DELETED", async () => {
    const vaultId = freshVaultId();
    await setTombstone(vaultId);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r = await scheduleDeletion(vaultId, "tok-boot", {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(410);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("VAULT_DELETED");
  });

  it("unknown vault → 404 UNKNOWN_VAULT", async () => {
    const vaultId = freshVaultId();
    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r = await scheduleDeletion(vaultId, "tok-boot", {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(404);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("UNKNOWN_VAULT");
  });

  it("missing bearer → 401", async () => {
    const vaultId = freshVaultId();
    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/schedule-deletion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduled: pair.scheduled, deleted: pair.deleted }),
    });
    expect(r.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("wrong bearer → 401", async () => {
    const vaultId = freshVaultId();
    await bootstrapVault(vaultId, "tok-boot");
    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r = await scheduleDeletion(vaultId, "tok-wrong", {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("malformed body (no scheduled) → 422", async () => {
    const vaultId = freshVaultId();
    await bootstrapVault(vaultId, "tok-boot");
    const r = await scheduleDeletion(vaultId, "tok-boot", { deleted: {} });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });
});

// --- POST /cancel-deletion ----------------------------------------------

describe("POST /v1/vault/:vaultId/cancel-deletion", () => {
  it("happy path → 200, cancelled event on GET, pending blob cleared, alarm cleared", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const r1 = await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    expect(r1.status).toBe(200);

    const cancelled = makeCancel({ clientNonce: nonce() });
    const r2 = await cancelDeletion(vaultId, token, { cancelled });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { assignedSeq: number };
    expect(body.assignedSeq).toBe(3); // bootstrap=1, scheduled=2, cancelled=3

    // GET surfaces all three events in seq order.
    const get = await pull(vaultId, token, 0);
    const getBody = (await get.json()) as {
      events: Array<{ seq: number; type: string }>;
    };
    expect(getBody.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "ItemSaved"],
      [2, "VaultDeletionScheduled"],
      [3, "VaultDeletionCancelled"],
    ]);

    // DO storage — pending blob + scheduledFor + alarm all cleared.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        expect(await state.storage.get("meta:pendingVaultDeleted")).toBeUndefined();
        expect(await state.storage.get("meta:scheduledFor")).toBeUndefined();
        expect(await state.storage.getAlarm()).toBeNull();
      },
    );
  });

  it("cancel with no pending deletion → 409 NO_PENDING_DELETION", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const cancelled = makeCancel({ clientNonce: nonceGen()() });
    const r = await cancelDeletion(vaultId, token, { cancelled });
    expect(r.status).toBe(409);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("NO_PENDING_DELETION");
  });

  it("tombstoned vault → 410 VAULT_DELETED", async () => {
    const vaultId = freshVaultId();
    await setTombstone(vaultId);
    const cancelled = makeCancel({ clientNonce: nonceGen()() });
    const r = await cancelDeletion(vaultId, "tok-boot", { cancelled });
    expect(r.status).toBe(410);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("VAULT_DELETED");
  });

  it("unknown vault → 404 UNKNOWN_VAULT", async () => {
    const vaultId = freshVaultId();
    const cancelled = makeCancel({ clientNonce: nonceGen()() });
    const r = await cancelDeletion(vaultId, "tok-boot", { cancelled });
    expect(r.status).toBe(404);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("UNKNOWN_VAULT");
  });

  it("missing bearer → 401", async () => {
    const vaultId = freshVaultId();
    const cancelled = makeCancel({ clientNonce: nonceGen()() });
    const r = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/cancel-deletion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cancelled }),
    });
    expect(r.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("wrong bearer → 401", async () => {
    const vaultId = freshVaultId();
    await bootstrapVault(vaultId, "tok-boot");
    const cancelled = makeCancel({ clientNonce: nonceGen()() });
    const r = await cancelDeletion(vaultId, "tok-wrong", { cancelled });
    expect(r.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("malformed body (no cancelled) → 422", async () => {
    const vaultId = freshVaultId();
    await bootstrapVault(vaultId, "tok-boot");
    // need pending state to ensure schema check fires before the
    // no-pending-deletion check
    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    await scheduleDeletion(vaultId, "tok-boot", {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    const r = await cancelDeletion(vaultId, "tok-boot", {});
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });
});

// --- event-log integration -----------------------------------------------

describe("schedule + cancel round-trip — event log + nonce keyspace", () => {
  it("GET /events?since=0 returns bootstrap + scheduled + cancelled in monotonic seq order; both clientNonces recorded", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const scheduledNonce = nonce();
    const deletedNonce = nonce();
    const pair = makeSchedulePair({
      scheduledNonce,
      deletedNonce,
    });
    await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });
    const cancelledNonce = nonce();
    const cancelled = makeCancel({ clientNonce: cancelledNonce });
    await cancelDeletion(vaultId, token, { cancelled });

    const get = await pull(vaultId, token, 0);
    const body = (await get.json()) as {
      events: Array<{ seq: number; type: string; deviceId: string; clientNonce: string }>;
    };
    expect(body.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "ItemSaved"],
      [2, "VaultDeletionScheduled"],
      [3, "VaultDeletionCancelled"],
    ]);
    // The seq sequence is monotonic +1 — schedule and cancel both go through
    // the same seq-assignment path as POST /events.
    expect(body.events[1]?.clientNonce).toBe(scheduledNonce);
    expect(body.events[2]?.clientNonce).toBe(cancelledNonce);

    // Verify the nonces are registered in the nonce keyspace: re-POSTing an
    // event with the same (deviceId, clientNonce) via POST /events → 409.
    const replay = await push(vaultId, token, [
      // Re-uses the scheduling envelope's nonce on a different event type;
      // the relay's replay check is keyed on (deviceId, clientNonce), not on
      // payload, so this must 409.
      pendingItemSaved({
        clientNonce: scheduledNonce,
        deviceId: "device-boot",
      }),
    ]);
    expect(replay.status).toBe(409);
    const env_ = ErrorEnvelopeSchema.parse(await replay.json());
    expect(env_.code).toBe("DUPLICATE_CLIENT_NONCE");
  });
});

// --- DO alarm bookkeeping ------------------------------------------------

describe("DO alarm bookkeeping (schedule vs cancel)", () => {
  it("after schedule, getAlarm() returns scheduledFor; after cancel, getAlarm() is null", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    await scheduleDeletion(vaultId, token, {
      scheduled: pair.scheduled,
      deleted: pair.deleted,
    });

    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBe(pair.scheduledFor);
      },
    );

    const cancelled = makeCancel({ clientNonce: nonce() });
    await cancelDeletion(vaultId, token, { cancelled });

    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
      },
    );
  });
});
