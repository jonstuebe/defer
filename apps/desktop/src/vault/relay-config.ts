import { generateDeviceAuthToken, ready } from "@defer/core/crypto";

import { bytesToBase64Url } from "../util/base64.js";
import type { StoragePort } from "../storage/index.js";

// Wire format for `deviceAuthToken` is 22-char base64url = 16 bytes
// (`DEVICE_ID_REGEX` in relay-protocol/wire.ts; same shape used for
// `deviceId`, matching the e2e test fixture in tests/e2e). `@defer/core/
// crypto` mints 32 bytes today — a pre-existing inconsistency between the
// crypto module and the wire schema. We truncate here rather than at the
// crypto boundary so the wider fix can land separately without breaking
// every desktop install.
const WIRE_TOKEN_BYTES = 16;

export const SETTING_RELAY_BASE_URL = "relay.baseUrl";
export const SETTING_DEVICE_AUTH_TOKEN = "device.authTokenBase64Url";

/**
 * Default relay URL used when a fresh vault hasn't picked one yet.
 *
 * No production endpoint is hard-coded here on purpose — the BYO-relay
 * setting (slice #56) lets every user pick their own deployment. The
 * placeholder below is the recommended local-dev wrangler URL and points
 * at the relay running on `pnpm --filter @defer/relay dev` (port 8787).
 * Until slice #56 ships a Settings page, the user can override via the
 * `settings.relay.baseUrl` row directly in their local SQLite if they
 * deploy to their own Cloudflare account.
 */
export const DEFAULT_RELAY_BASE_URL = "http://localhost:8787";

export async function getRelayBaseUrl(storage: StoragePort): Promise<string> {
  return (await storage.getSetting(SETTING_RELAY_BASE_URL)) ?? DEFAULT_RELAY_BASE_URL;
}

export async function setRelayBaseUrl(storage: StoragePort, url: string): Promise<void> {
  // Validate at the boundary — a malformed URL setting becomes a hard-to-
  // debug fetch-side error otherwise. Throws if `url` is not parseable.
  // Trailing slashes are stripped by `RelayClient`'s constructor, so we
  // do not normalise here.
  new URL(url);
  await storage.setSetting(SETTING_RELAY_BASE_URL, url);
}

/**
 * Returns the locally-minted device auth token, creating one on first call.
 *
 * In slice #45 the token wasn't minted (no relay to authenticate to). In
 * slice #46 the first outbound flush needs a bearer — we mint it lazily so
 * users created in slice #45 keep working without a re-onboarding. The
 * token is a 32-byte CSPRNG value rendered as 22-char base64url.
 */
export async function ensureDeviceAuthToken(storage: StoragePort): Promise<string> {
  const existing = await storage.getSetting(SETTING_DEVICE_AUTH_TOKEN);
  if (existing !== undefined) return existing;
  await ready;
  const token = bytesToBase64Url(generateDeviceAuthToken().slice(0, WIRE_TOKEN_BYTES));
  await storage.setSetting(SETTING_DEVICE_AUTH_TOKEN, token);
  return token;
}
