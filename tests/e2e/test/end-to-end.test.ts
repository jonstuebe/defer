import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

import {
  decryptEvent,
  encryptEvent,
  generateDeviceAuthToken,
  generateDeviceId,
  generateVaultKey,
  ready,
} from "@defer/core/crypto";
import { deriveVaultIdFromKey } from "@defer/core";
import { ErrorEnvelopeSchema, PullEventsResponseSchema } from "@defer/core/relay-protocol";

// End-to-end demo harness — issue #31, the milestone-completion gate for
// Phase 2. The harness exists to catch protocol mismatches that the
// per-package unit tests can miss: AAD field order, base64 vs base64url,
// header name typos, etc.
//
// Why this lives in a sibling `tests/e2e/` workspace and not in
// `apps/relay/test/e2e/` (the originally-favored location):
//
//   The @defer/core crypto module depends on libsodium-wrappers-sumo, which
//   compiles its WASM bytes at module-init time via
//   `WebAssembly.instantiate()`. The Cloudflare vitest-pool-workers harness
//   runs tests INSIDE workerd, and workerd's embedder disallows runtime WASM
//   compilation ("Wasm code generation disallowed by embedder"). Only static
//   wasm bindings declared in wrangler.toml are allowed. So the harness
//   cannot run @defer/core/crypto inside the workers test pool.
//
//   This workspace runs the harness in Node (where libsodium works fine) and
//   talks to a real workerd instance booted via `wrangler unstable_dev`. The
//   relay still runs in workerd — only the test driver moved out — so we
//   exercise the real HTTP transport rather than an in-process SELF.fetch
//   shortcut. That's a strictly better fidelity for an e2e harness anyway.
//
// What this harness asserts end-to-end:
//   1. Real crypto from @defer/core (encrypt with vault key + AAD per
//      ADR-0006 §4.1) round-trips through the relay's wire schemas.
//   2. The bearer-auth flow (ADR-0007 §1 first-write self-registration)
//      works with a derived `deviceAuthToken`.
//   3. Sad-path envelopes match `ErrorEnvelopeSchema` exactly.
//   4. The router-boundary `VAULT_ID_REGEX` check (added with this PR)
//      rejects malformed vaultId path params with 422 SCHEMA_VIOLATION.
//   5. Client-side AAD verification fails when ciphertext is mutated, as
//      ADR-0006 promises.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `apps/relay/wrangler.toml` is the production configuration the relay ships
// with — we point unstable_dev at it directly so the test exercises the same
// bindings (Durable Object, KV namespace, vars) production uses. The dev
// server defaults to localhost and an OS-assigned port.
const RELAY_WRANGLER_CONFIG = path.resolve(__dirname, "../../../apps/relay/wrangler.toml");

let worker: Unstable_DevWorker;
let baseUrl: string;

beforeAll(async () => {
  // Sodium init: @defer/core/crypto's primitives all `assertReady()`. We must
  // await the module's exported `ready` promise before calling any of them.
  await ready;

  worker = await unstable_dev(path.resolve(__dirname, "../../../apps/relay/src/index.ts"), {
    config: RELAY_WRANGLER_CONFIG,
    // `local: true` ensures Miniflare/workerd, not a real Cloudflare edge —
    // hermetic CI requirement from issue #31.
    local: true,
    // No remote experimental features, no live logging spam in CI output.
    experimental: { disableExperimentalWarning: true, testMode: false },
    // Pin a host/port that wrangler can bind, but `port: 0` doesn't work in
    // some versions, so we let wrangler pick.
  });
  baseUrl = `http://${worker.address}:${worker.port}`;
}, 60_000);

afterAll(async () => {
  if (worker) {
    await worker.stop();
  }
});

// --- byte helpers --------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// --- fixture builders ----------------------------------------------------

interface VaultFixture {
  vaultKey: Uint8Array;
  vaultIdBytes: Uint8Array;
  vaultIdB64: string;
  deviceIdBytes: Uint8Array;
  deviceId: string;
  deviceAuthToken: string;
}

function freshVault(): VaultFixture {
  const vaultKey = generateVaultKey();
  const vaultIdBytes = deriveVaultIdFromKey(vaultKey);
  const vaultIdB64 = bytesToBase64Url(vaultIdBytes);
  const deviceIdBytes = generateDeviceId();
  const deviceId = bytesToBase64Url(deviceIdBytes);
  // The relay treats the bearer as an opaque 22-char base64url string. The
  // generator returns 32 bytes; we use the first 16 to match the
  // RegisterDeviceRequestSchema device-token regex.
  const tokenBytes = generateDeviceAuthToken().slice(0, 16);
  const deviceAuthToken = bytesToBase64Url(tokenBytes);
  return { vaultKey, vaultIdBytes, vaultIdB64, deviceIdBytes, deviceId, deviceAuthToken };
}

interface ItemSavedPayload {
  itemId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  savedAt: number;
}

function freshItemSavedPayload(): ItemSavedPayload {
  return {
    itemId: `item-${Math.random().toString(36).slice(2, 10)}`,
    url: "https://example.com/article",
    canonicalUrl: "https://example.com/article",
    title: "An article",
    savedAt: 1_700_000_000_000,
  };
}

interface EncryptedPendingEvent {
  envelope: Record<string, unknown>;
  payload: ItemSavedPayload;
  ciphertextB64: string;
  nonceB64: string;
  clientNonceBytes: Uint8Array;
}

// Build an encrypted `PendingEvent` envelope. The envelope's `data` slot
// satisfies the PendingItemSavedSchema (so the relay accepts it) and carries
// the ciphertext + AEAD nonce in two extra fields (`__ciphertext`, `__nonce`).
// Zod's default strip-unknowns behaviour means the relay validates the
// envelope without seeing these, and the GET response omits them. For the
// harness we use the in-memory `built` object as the source of truth for the
// ciphertext side — what we verify on the GET is that the cleartext routing
// fields round-trip byte-for-byte, then we feed those + the in-memory
// ciphertext into decryptEvent to verify the AAD binding survives transport.
//
// The production wire format for encrypted events is out of scope for this
// PR (no event schema today carries ciphertext); the harness still exercises
// the full crypto + transport stack so any drift in either is caught.
function buildEncryptedEvent(
  fixture: VaultFixture,
  payload: ItemSavedPayload = freshItemSavedPayload(),
): EncryptedPendingEvent {
  const clientNonceBytes = new Uint8Array(16);
  crypto.getRandomValues(clientNonceBytes);
  const clientNonce = bytesToBase64Url(clientNonceBytes);

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const { ciphertext, nonce } = encryptEvent({
    vaultKey: fixture.vaultKey,
    plaintext,
    aad: {
      vaultId: fixture.vaultIdBytes,
      deviceId: fixture.deviceIdBytes,
      clientNonce: clientNonceBytes,
    },
  });

  const ciphertextB64 = bytesToBase64Url(ciphertext);
  const nonceB64 = bytesToBase64Url(nonce);

  return {
    envelope: {
      type: "ItemSaved",
      deviceId: fixture.deviceId,
      timestamp: 1_700_000_000_000,
      clientNonce,
      data: {
        itemId: payload.itemId,
        url: payload.url,
        canonicalUrl: payload.canonicalUrl,
        title: "",
        savedAt: payload.savedAt,
        __ciphertext: ciphertextB64,
        __nonce: nonceB64,
      },
    },
    payload,
    ciphertextB64,
    nonceB64,
    clientNonceBytes,
  };
}

async function postEvents(
  vaultIdB64: string,
  bearer: string,
  events: Record<string, unknown>[],
): Promise<Response> {
  return fetch(`${baseUrl}/v1/vault/${vaultIdB64}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ events }),
  });
}

async function getEvents(vaultIdB64: string, bearer: string, since: number): Promise<Response> {
  return fetch(`${baseUrl}/v1/vault/${vaultIdB64}/events?since=${since}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

// --- happy path ----------------------------------------------------------

describe("end-to-end: @defer/core ↔ apps/relay", () => {
  it("encrypts → POSTs → GETs → decrypts → AAD-verifies → deep-equals", async () => {
    const fixture = freshVault();
    const built = buildEncryptedEvent(fixture);

    const postResp = await postEvents(fixture.vaultIdB64, fixture.deviceAuthToken, [
      built.envelope,
    ]);
    expect(postResp.status).toBe(200);
    const postBody = (await postResp.json()) as { assigned: number[] };
    expect(postBody.assigned).toEqual([1]);

    const getResp = await getEvents(fixture.vaultIdB64, fixture.deviceAuthToken, 0);
    expect(getResp.status).toBe(200);
    const getBody = PullEventsResponseSchema.parse(await getResp.json());
    expect(getBody.events.length).toBe(1);
    const returned = getBody.events[0]!;
    expect(returned.seq).toBe(1);
    expect(returned.clientNonce).toBe(bytesToBase64Url(built.clientNonceBytes));
    expect(returned.deviceId).toBe(fixture.deviceId);

    // Rebuild the AAD from the returned envelope's cleartext routing fields.
    // If a malicious relay had mutated vaultId / deviceId / clientNonce in
    // transit, this rebuild would produce different AAD bytes and the
    // decrypt below would fail loudly.
    const aadVaultId = base64UrlToBytes(fixture.vaultIdB64);
    const aadDeviceId = base64UrlToBytes(returned.deviceId);
    const aadClientNonce = base64UrlToBytes(returned.clientNonce);
    const plaintext = decryptEvent({
      vaultKey: fixture.vaultKey,
      nonce: base64UrlToBytes(built.nonceB64),
      ciphertext: base64UrlToBytes(built.ciphertextB64),
      aad: {
        vaultId: aadVaultId,
        deviceId: aadDeviceId,
        clientNonce: aadClientNonce,
      },
    });

    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as ItemSavedPayload;
    expect(decoded).toEqual(built.payload);
  });

  // --- sad path: bad token ------------------------------------------------

  it("rejects POST with unknown bearer → 401 INVALID_TOKEN envelope", async () => {
    const fixture = freshVault();
    const r1 = await postEvents(fixture.vaultIdB64, fixture.deviceAuthToken, [
      buildEncryptedEvent(fixture).envelope,
    ]);
    expect(r1.status).toBe(200);

    const wrongToken = bytesToBase64Url(generateDeviceAuthToken().slice(0, 16));
    const r2 = await postEvents(fixture.vaultIdB64, wrongToken, [
      buildEncryptedEvent(fixture).envelope,
    ]);
    expect(r2.status).toBe(401);
    const envelope = ErrorEnvelopeSchema.parse(await r2.json());
    expect(envelope.code).toBe("INVALID_TOKEN");
    expect(envelope.error).toBe("unauthorized");
  });

  // --- sad path: tampered ciphertext --------------------------------------

  it("flips one byte of ciphertext → client-side AAD verification fails", async () => {
    const fixture = freshVault();
    const built = buildEncryptedEvent(fixture);

    const postResp = await postEvents(fixture.vaultIdB64, fixture.deviceAuthToken, [
      built.envelope,
    ]);
    expect(postResp.status).toBe(200);

    const tampered = base64UrlToBytes(built.ciphertextB64);
    expect(tampered.length).toBeGreaterThan(0);
    tampered[0] = tampered[0]! ^ 0x01;

    expect(() =>
      decryptEvent({
        vaultKey: fixture.vaultKey,
        nonce: base64UrlToBytes(built.nonceB64),
        ciphertext: tampered,
        aad: {
          vaultId: fixture.vaultIdBytes,
          deviceId: fixture.deviceIdBytes,
          clientNonce: built.clientNonceBytes,
        },
      }),
    ).toThrow();
  });

  // --- sad path: malformed vaultId path param -----------------------------

  it("POST with non-base64url vaultId → 422 SCHEMA_VIOLATION", async () => {
    // The router-boundary VAULT_ID_REGEX (added with this PR in
    // `relay-api.ts`) rejects any vaultId path param that isn't 22 base64url
    // chars before the request reaches the DO. The body content doesn't
    // matter — the rejection happens during route dispatch.
    const fixture = freshVault();
    const built = buildEncryptedEvent(fixture);
    const r = await fetch(`${baseUrl}/v1/vault/not-a-valid-vault-id-shape/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.deviceAuthToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: [built.envelope] }),
    });
    expect(r.status).toBe(422);
    const envelope = ErrorEnvelopeSchema.parse(await r.json());
    expect(envelope.code).toBe("SCHEMA_VIOLATION");
  });

  // --- sad path: empty pull -----------------------------------------------

  it("GET ?since past end → 200 with empty events array", async () => {
    const fixture = freshVault();
    const built = buildEncryptedEvent(fixture);
    const r1 = await postEvents(fixture.vaultIdB64, fixture.deviceAuthToken, [built.envelope]);
    expect(r1.status).toBe(200);

    const r2 = await getEvents(fixture.vaultIdB64, fixture.deviceAuthToken, 999);
    expect(r2.status).toBe(200);
    const body = PullEventsResponseSchema.parse(await r2.json());
    expect(body.events).toEqual([]);
    expect(body.nextSince).toBeNull();
  });
});
