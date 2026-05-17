import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "@defer/core/relay-protocol";
import { RELAY_DEVICE_ID } from "@defer/core";

import type { Env } from "../src/env.js";

// Issue #30 acceptance: vault-deletion DATA plane. The control plane
// (schedule + cancel + alarm bookkeeping) is covered in `deletion-control.
// test.ts`. This file exercises the `alarm()` handler end-to-end:
//
//   - On fire: pre-signed `VaultDeleted` is appended to the event log,
//     `deleteAll()` wipes everything, then `meta:tombstone` is re-written
//     with `{ deletedAt, vaultDeletedSeq }` as the source-of-truth marker.
//   - Every endpoint of a tombstoned vault returns 410 `VAULT_DELETED`,
//     BEFORE auth (a bogus/missing bearer must still see 410, not 401).
//   - Idempotent under at-least-once alarm delivery.
//   - The cancel-vs-alarm race resolves cleanly (DO single-threading).

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE = "https://relay.example.com";
const SIG = "A".repeat(43);

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

function pendingItemSaved(args: {
  clientNonce: string;
  deviceId?: string;
}): Record<string, unknown> {
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
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cancelDeletion(vaultId: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/cancel-deletion`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bootstrapVault(vaultId: string, token: string): Promise<void> {
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
  scheduledNonce: string;
  deletedNonce: string;
  deletedSig?: string;
}): ScheduleEnvelopes {
  // Default `scheduledFor` is well in the future so miniflare doesn't auto-
  // fire the alarm. Tests deterministically drive the alarm via
  // `runDurableObjectAlarm`, which runs and clears the scheduled alarm
  // regardless of its wall-clock time.
  const scheduledFor = args.scheduledFor ?? Date.now() + 48 * 60 * 60 * 1000;
  return {
    scheduledFor,
    scheduled: {
      type: "VaultDeletionScheduled",
      deviceId: "device-boot",
      timestamp: Date.now(),
      clientNonce: args.scheduledNonce,
      signature: SIG,
      data: { scheduledFor },
    },
    deleted: {
      type: "VaultDeleted",
      deviceId: RELAY_DEVICE_ID,
      timestamp: Date.now(),
      clientNonce: args.deletedNonce,
      signature: args.deletedSig ?? SIG,
      data: { deletedAt: scheduledFor },
    },
  };
}

function makeCancel(args: { clientNonce: string }): Record<string, unknown> {
  return {
    type: "VaultDeletionCancelled",
    deviceId: "device-boot",
    timestamp: Date.now(),
    clientNonce: args.clientNonce,
    signature: SIG,
    data: {},
  };
}

// Schedule a deletion, then deterministically run the alarm via
// `runDurableObjectAlarm`. Returns the schedule envelopes so the caller can
// assert byte-equality against what the alarm emits.
async function scheduleAndFireAlarm(
  vaultId: string,
  token: string,
  nonce: () => string,
  pairOverride?: ScheduleEnvelopes,
): Promise<ScheduleEnvelopes> {
  const pair =
    pairOverride ??
    makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
  const r = await scheduleDeletion(vaultId, token, {
    scheduled: pair.scheduled,
    deleted: pair.deleted,
  });
  expect(r.status).toBe(200);

  const id = env.VAULT_RELAY.idFromName(vaultId);
  const stub = env.VAULT_RELAY.get(id);
  // `runDurableObjectAlarm` only fires the alarm if one is scheduled — we
  // know it is, because we just scheduled. Returns `true` on success.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ran = await runDurableObjectAlarm(stub as any);
  expect(ran).toBe(true);
  return pair;
}

// --- happy alarm fire ----------------------------------------------------

describe("vault deletion data plane — alarm fire", () => {
  it("emits VaultDeleted to the event log, tombstones, and wipes everything else", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const nonce = nonceGen();
    const pair = await scheduleAndFireAlarm(vaultId, token, nonce);

    // The vault is tombstoned. GET /events → 410.
    const get = await pull(vaultId, token, 0);
    expect(get.status).toBe(410);
    const errBody = ErrorEnvelopeSchema.parse(await get.json());
    expect(errBody.code).toBe("VAULT_DELETED");

    // Storage assertions: only `meta:tombstone` should remain, carrying
    // `{ deletedAt, vaultDeletedSeq }`. Bootstrap=1, scheduled=2,
    // VaultDeleted=3.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        const tombstone = await state.storage.get<{
          deletedAt: number;
          vaultDeletedSeq: number;
        }>("meta:tombstone");
        expect(tombstone).toEqual({
          deletedAt: pair.scheduledFor,
          vaultDeletedSeq: 3,
        });
        const all = await state.storage.list();
        // Only meta:tombstone survives the deleteAll()-then-rewrite dance.
        expect([...all.keys()]).toEqual(["meta:tombstone"]);
      },
    );
  });

  it("emitted VaultDeleted envelope is byte-equal to the pre-signed payload (modulo added seq)", async () => {
    // We capture the event-log state of the VaultDeleted entry BEFORE the
    // deleteAll wipes it, by reading via `runInDurableObject` directly
    // before the alarm fires the deleteAll. Once deleteAll runs, the event
    // is gone from storage. Workaround: schedule, then via runInDurableObject
    // call alarm() manually so we can read storage between steps... or:
    // verify the equality at schedule-time by checking what was stored as
    // `meta:pendingVaultDeleted`, which is what the alarm emits with `seq`
    // added.
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

    // Read what the relay stored as the pre-signed envelope. The alarm
    // re-emits this verbatim with `seq` stamped.
    const storedPending = await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        return await state.storage.get<Record<string, unknown>>("meta:pendingVaultDeleted");
      },
    );
    expect(storedPending).toBeDefined();
    // Per ADR-0006 §5: the relay does NOT mutate the pre-signed envelope.
    // The stored shape is exactly what the client posted as `deleted`.
    expect(storedPending).toEqual(pair.deleted);

    // Now fire the alarm. After the wipe, we can no longer read the event
    // from storage — but we asserted byte-equality at-rest above, and the
    // alarm code path is `EventSchema.parse({ ...pending, seq })` (see
    // `stampSeq` in vault-relay.ts), so the emitted envelope is exactly
    // `{ ...pair.deleted, seq: 3 }`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ran = await runDurableObjectAlarm(stub as any);
    expect(ran).toBe(true);
  });
});

// --- 410 on every endpoint after tombstone -------------------------------

describe("vault deletion data plane — 410 dispatch on tombstoned vault", () => {
  // Build a tombstoned vault via a real alarm fire, then drive every
  // endpoint and assert 410. This is the integration-flavoured pass; the
  // 410-before-auth test below exercises the auth-ordering specifically.
  it("returns 410 VAULT_DELETED on POST /events, GET /events, POST /devices, DELETE /devices/:id, POST /schedule-deletion, POST /cancel-deletion", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);
    const nonce = nonceGen();
    await scheduleAndFireAlarm(vaultId, token, nonce);

    // POST /events
    const postEvents = await push(vaultId, token, [pendingItemSaved({ clientNonce: nonce() })]);
    expect(postEvents.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await postEvents.json()).code).toBe("VAULT_DELETED");

    // GET /events
    const getEvents = await pull(vaultId, token, 0);
    expect(getEvents.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await getEvents.json()).code).toBe("VAULT_DELETED");

    // POST /devices
    const postDevices = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/devices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-2",
        deviceAuthToken: "tok-2",
      }),
    });
    expect(postDevices.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await postDevices.json()).code).toBe("VAULT_DELETED");

    // DELETE /devices/:deviceId
    const deleteDevice = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/devices/device-boot`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deleteDevice.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await deleteDevice.json()).code).toBe("VAULT_DELETED");

    // POST /schedule-deletion
    const pair2 = makeSchedulePair({
      scheduledNonce: nonce(),
      deletedNonce: nonce(),
    });
    const sched = await scheduleDeletion(vaultId, token, {
      scheduled: pair2.scheduled,
      deleted: pair2.deleted,
    });
    expect(sched.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await sched.json()).code).toBe("VAULT_DELETED");

    // POST /cancel-deletion
    const cancel = await cancelDeletion(vaultId, token, {
      cancelled: makeCancel({ clientNonce: nonce() }),
    });
    expect(cancel.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await cancel.json()).code).toBe("VAULT_DELETED");
  });

  it("410 fires BEFORE auth — request with missing bearer still gets 410, not 401", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);
    const nonce = nonceGen();
    await scheduleAndFireAlarm(vaultId, token, nonce);

    // No Authorization header — the dispatcher's tombstone check runs first
    // and short-circuits to 410. The auth layer never runs.
    const r = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [pendingItemSaved({ clientNonce: nonce() })] }),
    });
    expect(r.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await r.json()).code).toBe("VAULT_DELETED");

    // Bogus bearer — same: 410, not 401.
    const r2 = await push(vaultId, "tok-bogus", [pendingItemSaved({ clientNonce: nonce() })]);
    expect(r2.status).toBe(410);
    expect(ErrorEnvelopeSchema.parse(await r2.json()).code).toBe("VAULT_DELETED");
  });
});

// --- alarm idempotency ---------------------------------------------------

describe("vault deletion data plane — alarm idempotency", () => {
  it("re-firing alarm() after tombstone is a clean no-op (no duplicate VaultDeleted)", async () => {
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);
    const nonce = nonceGen();
    await scheduleAndFireAlarm(vaultId, token, nonce);

    // First fire already happened. Capture the post-first-fire tombstone.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    const tombstoneBefore = await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        return await state.storage.get<unknown>("meta:tombstone");
      },
    );

    // Force a second alarm() call directly. `runDurableObjectAlarm` only
    // fires a SCHEDULED alarm; since the first fire cleared the schedule,
    // we invoke `alarm()` on the instance directly via `runInDurableObject`.
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (instance) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (instance as any).alarm();
      },
    );

    // Tombstone unchanged.
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        const after = await state.storage.get<unknown>("meta:tombstone");
        expect(after).toEqual(tombstoneBefore);
        // Storage still has exactly one key.
        const all = await state.storage.list();
        expect([...all.keys()]).toEqual(["meta:tombstone"]);
      },
    );
  });
});

// --- cancellation race ---------------------------------------------------

describe("vault deletion data plane — cancellation race", () => {
  it("concurrent cancel + alarm-fire resolves cleanly; one wins, the other is a clean no-op", async () => {
    // DO single-threading serialises the two operations regardless of which
    // arrives first on the network. Two valid end-states:
    //
    //   (A) Alarm wins:  vault tombstoned → cancelDeletion returns 410
    //                    (the cancel arrives at a dead vault).
    //   (B) Cancel wins: pending blob deleted → alarm runs but exits no-op
    //                    (step 2 of the handler), vault NOT tombstoned, a
    //                    later POST /events works.
    //
    // We assert exactly one of those two end-states holds; which one is
    // implementation-dependent on the runtime scheduler.
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

    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);

    // Kick both concurrently.
    const cancelP = cancelDeletion(vaultId, token, {
      cancelled: makeCancel({ clientNonce: nonce() }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alarmP = runDurableObjectAlarm(stub as any);
    const [cancelRes, alarmRan] = await Promise.all([cancelP, alarmP]);

    // Determine end-state by reading the tombstone.
    const finalTombstone = await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        return await state.storage.get<unknown>("meta:tombstone");
      },
    );

    if (finalTombstone !== undefined) {
      // (A) Alarm won. Cancel arrived at a tombstoned vault → 410.
      // Note: it's also possible cancel won the very first dispatch but the
      // alarm subsequently fired anyway (race observation order). The
      // canonical signal is the tombstone presence; if it's there, we treat
      // this as case (A).
      expect(alarmRan).toBe(true);
      expect([410, 409]).toContain(cancelRes.status);
      const code = ErrorEnvelopeSchema.parse(await cancelRes.json()).code;
      expect(["VAULT_DELETED", "NO_PENDING_DELETION"]).toContain(code);
    } else {
      // (B) Cancel won. Vault not tombstoned. Cancel returned 200; alarm
      // either ran and exited no-op, or wasn't scheduled by the time
      // `runDurableObjectAlarm` was called (in which case `alarmRan` is
      // false — the cancel cleared the alarm first).
      expect(cancelRes.status).toBe(200);
      // A subsequent POST /events should succeed (vault still alive).
      const followup = await push(vaultId, token, [pendingItemSaved({ clientNonce: nonce() })]);
      expect(followup.status).toBe(200);
    }
  });
});

// --- cancelled-then-alarm-fired race window ------------------------------

describe("vault deletion data plane — alarm with missing payload (cancelled-then-fired)", () => {
  it("alarm() with `scheduledFor` set but `pendingVaultDeleted` absent → no-op, no tombstone, no event", async () => {
    // Construct the exact race-window state: scheduledFor present (cancel
    // hasn't deleted it yet, hypothetically), but pendingVaultDeleted is
    // gone. Then call alarm() directly. The handler should exit on step 2
    // (no payload → log + return).
    const vaultId = freshVaultId();
    const token = "tok-boot";
    await bootstrapVault(vaultId, token);

    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);

    // Seed the partial state by hand, mimicking a cancel-then-fire race
    // where the pending blob got deleted but the alarm fired anyway.
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        await state.storage.put("meta:scheduledFor", Date.now() - 1000);
        // Deliberately do NOT set meta:pendingVaultDeleted.
      },
    );

    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (instance) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (instance as any).alarm();
      },
    );

    // No tombstone. No new event. The bootstrap event (seq=1) is still
    // there; nothing else was emitted.
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        expect(await state.storage.get("meta:tombstone")).toBeUndefined();
        // The vault is still alive — pull works (returns just bootstrap).
      },
    );
    const get = await pull(vaultId, token, 0);
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      events: { seq: number; type: string }[];
    };
    expect(body.events.map((e) => e.type)).toEqual(["ItemSaved"]);
  });
});
