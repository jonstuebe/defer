import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema } from "@defer/core/relay-protocol";

import type { Env } from "../src/env.js";

// Issue #27 acceptance: POST /v1/vault/:vaultId/devices and
// DELETE /v1/vault/:vaultId/devices/:deviceId on the per-vault Durable
// Object. Tests cover registration, revocation (including self-revoke and
// last-device-revoke), concurrent revoke-during-pull, and the bootstrap
// deviceId-capture migration that this slice introduces.

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// --- fixtures -----------------------------------------------------------

const BASE = "https://relay.example.com";

// 22-char base64url placeholders. Both `deviceId` and `deviceAuthToken` are
// validated by the wire schema against `[A-Za-z0-9_-]{22}`; tests use
// counter-suffixed letters so each fresh value is distinct.
function freshDeviceId(suffix: string): string {
  // Pad to exactly 22 base64url chars.
  return `device-id-${suffix}`.padEnd(22, "X").slice(0, 22);
}

function freshToken(suffix: string): string {
  return `device-tok-${suffix}`.padEnd(22, "X").slice(0, 22);
}

function freshVaultId(): string {
  // 22-char base64url (16 random bytes) — matches the production wire
  // format and the router-boundary VAULT_ID_REGEX in `relay-api.ts`.
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

function pendingItemSaved(args: {
  clientNonce: string;
  deviceId?: string;
}): Record<string, unknown> {
  return {
    type: "ItemSaved",
    deviceId: args.deviceId ?? freshDeviceId("boot"),
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

function registerDevice(
  vaultId: string,
  bearerToken: string,
  body: { deviceId?: string; deviceAuthToken?: string; [k: string]: unknown },
): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function revokeDevice(vaultId: string, bearerToken: string, deviceId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/vault/${vaultId}/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
}

async function setTombstone(vaultId: string): Promise<void> {
  // Same affordance as events.test.ts: flip the tombstone flag to simulate
  // the post-alarm "vault is gone" state. The alarm-fired path lands in #30.
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

/**
 * Bootstrap a vault with a single ItemSaved event so the DO is initialized
 * and `bootstrapToken` is registered as the owner of `bootstrapDeviceId`.
 * Returns nothing — callers care only that the side-effect happened.
 */
async function bootstrapVault(
  vaultId: string,
  bootstrapToken: string,
  bootstrapDeviceId: string,
): Promise<void> {
  const nonce = nonceGen();
  const r = await push(vaultId, bootstrapToken, [
    pendingItemSaved({ clientNonce: nonce(), deviceId: bootstrapDeviceId }),
  ]);
  expect(r.status).toBe(200);
}

// --- POST /devices ------------------------------------------------------

describe("POST /v1/vault/:vaultId/devices", () => {
  it("happy register: existing-vault device with valid token registers a new device → 200, both storage keys written", async () => {
    const vaultId = freshVaultId();
    const bootstrapToken = freshToken("boot");
    const bootstrapDevice = freshDeviceId("boot");
    await bootstrapVault(vaultId, bootstrapToken, bootstrapDevice);

    const newDevice = freshDeviceId("new1");
    const newToken = freshToken("new1");
    const r = await registerDevice(vaultId, bootstrapToken, {
      deviceId: newDevice,
      deviceAuthToken: newToken,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: true };
    expect(body).toEqual({ ok: true });

    // Verify storage layout: `token:<newToken> → { deviceId: newDevice }` and
    // `device:<newDevice> → <newToken>`.
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        const tokenRecord = await state.storage.get<{ deviceId: string }>(`token:${newToken}`);
        expect(tokenRecord).toEqual({ deviceId: newDevice });
        const reverse = await state.storage.get<string>(`device:${newDevice}`);
        expect(reverse).toBe(newToken);
      },
    );

    // And the new token is now valid for subsequent requests.
    const r2 = await pull(vaultId, newToken, 0);
    expect(r2.status).toBe(200);
  });

  it("duplicate deviceId → 409 DEVICE_ALREADY_REGISTERED with details.deviceId", async () => {
    const vaultId = freshVaultId();
    const bootstrapToken = freshToken("boot");
    const bootstrapDevice = freshDeviceId("boot");
    await bootstrapVault(vaultId, bootstrapToken, bootstrapDevice);

    // Same `deviceId` as the bootstrap — that's the easy duplicate path,
    // since the bootstrap path captured it.
    const r = await registerDevice(vaultId, bootstrapToken, {
      deviceId: bootstrapDevice,
      deviceAuthToken: freshToken("dup"),
    });
    expect(r.status).toBe(409);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("DEVICE_ALREADY_REGISTERED");
    expect(env_.details).toEqual({ deviceId: bootstrapDevice });
  });

  it("POST on unknown vault → 404 UNKNOWN_VAULT (not first-write — events-only)", async () => {
    const vaultId = freshVaultId();
    const r = await registerDevice(vaultId, freshToken("any"), {
      deviceId: freshDeviceId("a"),
      deviceAuthToken: freshToken("a"),
    });
    expect(r.status).toBe(404);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("UNKNOWN_VAULT");
  });

  it("POST on tombstoned vault → 410 VAULT_DELETED", async () => {
    const vaultId = freshVaultId();
    await setTombstone(vaultId);
    const r = await registerDevice(vaultId, freshToken("any"), {
      deviceId: freshDeviceId("a"),
      deviceAuthToken: freshToken("a"),
    });
    expect(r.status).toBe(410);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("VAULT_DELETED");
  });

  it("malformed body (21-char deviceId) → 422 SCHEMA_VIOLATION", async () => {
    const vaultId = freshVaultId();
    const bootstrapToken = freshToken("boot");
    const bootstrapDevice = freshDeviceId("boot");
    await bootstrapVault(vaultId, bootstrapToken, bootstrapDevice);

    const r = await registerDevice(vaultId, bootstrapToken, {
      deviceId: "A".repeat(21),
      deviceAuthToken: freshToken("a"),
    });
    expect(r.status).toBe(422);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("SCHEMA_VIOLATION");
  });

  it("missing bearer → 401 INVALID_TOKEN", async () => {
    const vaultId = freshVaultId();
    const r = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: freshDeviceId("a"),
        deviceAuthToken: freshToken("a"),
      }),
    });
    expect(r.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("wrong bearer → 401 INVALID_TOKEN", async () => {
    const vaultId = freshVaultId();
    const bootstrapToken = freshToken("boot");
    const bootstrapDevice = freshDeviceId("boot");
    await bootstrapVault(vaultId, bootstrapToken, bootstrapDevice);

    const r = await registerDevice(vaultId, freshToken("nope"), {
      deviceId: freshDeviceId("new"),
      deviceAuthToken: freshToken("new"),
    });
    expect(r.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });
});

// --- DELETE /devices/:deviceId ------------------------------------------

describe("DELETE /v1/vault/:vaultId/devices/:deviceId", () => {
  it("happy revoke by another device: register A and B; A revokes B; B's token now 401", async () => {
    const vaultId = freshVaultId();
    const tokA = freshToken("A");
    const devA = freshDeviceId("A");
    await bootstrapVault(vaultId, tokA, devA);

    const tokB = freshToken("B");
    const devB = freshDeviceId("B");
    const reg = await registerDevice(vaultId, tokA, {
      deviceId: devB,
      deviceAuthToken: tokB,
    });
    expect(reg.status).toBe(200);

    // Sanity: B's token is valid right now.
    const sanity = await pull(vaultId, tokB, 0);
    expect(sanity.status).toBe(200);

    // A revokes B.
    const r = await revokeDevice(vaultId, tokA, devB);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    // B's token is now 401 on the next request.
    const after = await pull(vaultId, tokB, 0);
    expect(after.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await after.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });

  it("self-revoke: A revokes A using A's own token → 200; A's token now 401", async () => {
    const vaultId = freshVaultId();
    const tokA = freshToken("A");
    const devA = freshDeviceId("A");
    await bootstrapVault(vaultId, tokA, devA);

    const r = await revokeDevice(vaultId, tokA, devA);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    const after = await pull(vaultId, tokA, 0);
    expect(after.status).toBe(401);
  });

  it("last-device revoke is allowed: vault becomes unreachable but DO is NOT tombstoned", async () => {
    const vaultId = freshVaultId();
    const tokA = freshToken("A");
    const devA = freshDeviceId("A");
    await bootstrapVault(vaultId, tokA, devA);

    const r = await revokeDevice(vaultId, tokA, devA);
    expect(r.status).toBe(200);

    // Empty token set: any token now 401s.
    const empty = await pull(vaultId, tokA, 0);
    expect(empty.status).toBe(401);
    const empty2 = await pull(vaultId, freshToken("other"), 0);
    expect(empty2.status).toBe(401);

    // DO is NOT tombstoned — storage is still readable. We assert this by
    // reaching into storage: `meta:tombstone` is unset and `meta:initialized`
    // remains true. (The deletion-alarm path in #30 is what tombstones.)
    const id = env.VAULT_RELAY.idFromName(vaultId);
    const stub = env.VAULT_RELAY.get(id);
    await runInDurableObject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      async (_instance, state) => {
        const tombstoned = await state.storage.get<boolean>("meta:tombstone");
        expect(tombstoned).toBeUndefined();
        const initialized = await state.storage.get<boolean>("meta:initialized");
        expect(initialized).toBe(true);
      },
    );
  });

  it("unknown deviceId → 404 UNKNOWN_DEVICE with details.deviceId", async () => {
    const vaultId = freshVaultId();
    const tokA = freshToken("A");
    const devA = freshDeviceId("A");
    await bootstrapVault(vaultId, tokA, devA);

    const ghost = freshDeviceId("ghost");
    const r = await revokeDevice(vaultId, tokA, ghost);
    expect(r.status).toBe(404);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("UNKNOWN_DEVICE");
    expect(env_.details).toEqual({ deviceId: ghost });
  });

  it("DELETE on unknown vault → 404 UNKNOWN_VAULT", async () => {
    const vaultId = freshVaultId();
    const r = await revokeDevice(vaultId, freshToken("any"), freshDeviceId("any"));
    expect(r.status).toBe(404);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("UNKNOWN_VAULT");
  });

  it("DELETE on tombstoned vault → 410 VAULT_DELETED", async () => {
    const vaultId = freshVaultId();
    await setTombstone(vaultId);
    const r = await revokeDevice(vaultId, freshToken("any"), freshDeviceId("any"));
    expect(r.status).toBe(410);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("VAULT_DELETED");
  });

  it("missing bearer → 401 INVALID_TOKEN", async () => {
    const vaultId = freshVaultId();
    const r = await SELF.fetch(`${BASE}/v1/vault/${vaultId}/devices/${freshDeviceId("any")}`, {
      method: "DELETE",
    });
    expect(r.status).toBe(401);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("INVALID_TOKEN");
  });
});

// --- Concurrency: revoke-during-pull -----------------------------------

describe("concurrency: revoke during in-flight pull", () => {
  it("parallel DELETE /devices/:id + GET /events → GET either completes (200) or 401, never a partial response", async () => {
    // PRD §"Testing Decisions → vaultRelay": the DO is single-threaded, so a
    // pull that races with a revoke either ran before the revoke (200) or
    // after it (401). Both outcomes are valid; what's invalid is a partial
    // / interleaved response body or a 5xx. We launch both with
    // `Promise.all` and assert the property holds.
    const vaultId = freshVaultId();
    const tokA = freshToken("A");
    const devA = freshDeviceId("A");
    await bootstrapVault(vaultId, tokA, devA);

    // Add a second device so we have a token to issue the DELETE from after
    // the test asserts that A's GET was either 200 or 401. We use A's token
    // for the DELETE (self-revoke) so the race is purely "DELETE A vs GET as A".
    const [delResp, getResp] = await Promise.all([
      revokeDevice(vaultId, tokA, devA),
      pull(vaultId, tokA, 0),
    ]);

    // The DELETE always succeeds (the token is valid at request entry for
    // both branches of the race, because A is registered).
    expect(delResp.status).toBe(200);

    // The GET is either 200 (DO ran the GET first) or 401 (DELETE first).
    expect([200, 401]).toContain(getResp.status);
    const getBody = await getResp.text();
    // Body parses as JSON in either case — proving no partial / interleaved
    // response. We don't assert on the contents beyond "valid JSON".
    expect(() => JSON.parse(getBody)).not.toThrow();
  });
});

// --- Bootstrap deviceId-capture migration ------------------------------

describe("bootstrap captures the first event's deviceId", () => {
  it("POST /events to a fresh vault registers events[0].deviceId; POST /devices for the same deviceId → 409", async () => {
    // The migration introduced in this slice: the first-write self-registration
    // path now captures the bootstrap deviceId. We prove it by attempting to
    // re-register the same deviceId via POST /devices — which must 409.
    const vaultId = freshVaultId();
    const tokA = freshToken("A");
    const devA = freshDeviceId("boot");
    await bootstrapVault(vaultId, tokA, devA);

    const r = await registerDevice(vaultId, tokA, {
      deviceId: devA,
      deviceAuthToken: freshToken("dup"),
    });
    expect(r.status).toBe(409);
    const env_ = ErrorEnvelopeSchema.parse(await r.json());
    expect(env_.code).toBe("DEVICE_ALREADY_REGISTERED");
    expect(env_.details).toEqual({ deviceId: devA });
  });

  it("bootstrap captures ONLY the first event's deviceId; later events' deviceIds remain unregistered", async () => {
    // Per spec: "If the bootstrap batch has multiple events from different
    // `deviceId`s, only the first event's `deviceId` ties to the bootstrap
    // token; subsequent events' `deviceId`s do NOT auto-register."
    const vaultId = freshVaultId();
    const tokA = freshToken("A");
    const devA = freshDeviceId("dA");
    const devB = freshDeviceId("dB");

    const nonce = nonceGen();
    const r = await push(vaultId, tokA, [
      pendingItemSaved({ clientNonce: nonce(), deviceId: devA }),
      pendingItemSaved({ clientNonce: nonce(), deviceId: devB }),
    ]);
    expect(r.status).toBe(200);

    // devA is registered — proven by 409 on re-registration.
    const r1 = await registerDevice(vaultId, tokA, {
      deviceId: devA,
      deviceAuthToken: freshToken("a2"),
    });
    expect(r1.status).toBe(409);

    // devB is NOT registered — proven by a successful POST /devices for it.
    const r2 = await registerDevice(vaultId, tokA, {
      deviceId: devB,
      deviceAuthToken: freshToken("b2"),
    });
    expect(r2.status).toBe(200);
  });
});
