// HMAC-SHA256 over a vaultId with the relay-local LOG_HMAC_SECRET, truncated
// to 16 hex chars (64 bits). The full 256-bit MAC is overkill for log
// correlation; truncation keeps log lines readable without leaking the raw
// vaultId. The secret rotates without breaking the relay — log scans that
// span a rotation just see two different hashes for the same vault, which is
// acceptable for the use cases (rate-limit triage, error correlation).
//
// This is NOT a security boundary. The blind-relay invariant (ADR-0001)
// already guarantees vaultIds never appear in logs in raw form; the hash is
// here so operators can correlate log lines for the same vault without
// learning the vault's identity.

const HASH_HEX_LENGTH = 16;

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function importKey(secret: string): Promise<CryptoKey> {
  if (cachedKey !== null && cachedKey.secret === secret) {
    return cachedKey.key;
  }
  const raw = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  cachedKey = { secret, key };
  return key;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Returns a 16-hex-char (64-bit) truncated HMAC-SHA256 of the vaultId under
 * the relay-local secret. Safe to embed in log lines.
 */
export async function hashVaultId(vaultId: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(vaultId));
  return bytesToHex(new Uint8Array(sig)).slice(0, HASH_HEX_LENGTH);
}
