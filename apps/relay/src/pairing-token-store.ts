import type { KVNamespace } from "@cloudflare/workers-types";

// Thin wrapper over the `PAIRING_TOKENS` KV binding. The pairing handshake
// (ADR-0003 §"pairing handshake") stores a sealed `(vaultKey, deviceAuthToken)`
// blob under a 22-char base64url pairing token; the new device polls for
// ≤60s and unseals locally. The relay never sees plaintext.
//
// Funneling KV access through this class keeps the storage layer pinned to a
// single module — if the backend ever swaps (e.g. Workers KV → R2 metadata),
// only this file changes, not every route handler. Issue #28 introduced this
// implementation; the prior skeleton matched the same `get`/`put` shape so
// existing call-sites need no migration.
//
// **TTL.** Every `put` uses `expirationTtl: 60`. KV enforces expiry server-
// side; the value disappears from `get` results once expired. The PRD's
// "polls for ≤60s" wording maps directly onto this TTL — the relay doesn't
// implement its own clock-based eviction.
//
// **Idempotency.** Issuing two `put`s with the same token overwrites and
// resets the TTL. The pairing flow doesn't reuse tokens, so this is a
// theoretical-only concern; the spec doesn't require 409 here and adding one
// would force the client to retry-after-failure for what is functionally a
// no-op. The endpoint emits 204 on re-PUT for that reason.

/** TTL in seconds for every pairing-token entry. ADR-0003 / PRD §"Pairing handshake". */
export const PAIRING_TOKEN_TTL_SECONDS = 60;

export class PairingTokenStore {
  constructor(private readonly kv: KVNamespace) {}

  /**
   * Store the sealed payload (base64 string, exactly as it arrived on the
   * wire) under `token`, with the canonical 60-second TTL. Round-tripping
   * the wire string avoids a redundant decode/encode cycle on every GET —
   * clients hand the relay a base64 string and expect the same bytes back.
   */
  async put(token: string, sealedPayloadB64: string): Promise<void> {
    await this.kv.put(token, sealedPayloadB64, {
      expirationTtl: PAIRING_TOKEN_TTL_SECONDS,
    });
  }

  /**
   * Returns the stored base64 string, or `null` if the token was never
   * stored OR has expired. The relay does NOT distinguish expired vs. never-
   * existed at the wire (ADR-0007 §2): both surface as 404 UNKNOWN_PAIRING_TOKEN.
   */
  async get(token: string): Promise<string | null> {
    return this.kv.get(token, "text");
  }
}
