import { describe, expect, it } from "vitest";

import { initSqlForNode } from "../../tests/init-sql-for-node.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";
import {
  DEFAULT_RELAY_BASE_URL,
  ensureDeviceAuthToken,
  getRelayBaseUrl,
  setRelayBaseUrl,
} from "./relay-config.js";

async function makeStorage() {
  const SQL = await initSqlForNode();
  const storage = new SqliteStorage(SQL);
  await storage.init();
  return storage;
}

describe("relay-config", () => {
  it("returns DEFAULT_RELAY_BASE_URL when no setting is present", async () => {
    const storage = await makeStorage();
    expect(await getRelayBaseUrl(storage)).toBe(DEFAULT_RELAY_BASE_URL);
  });

  it("round-trips a custom URL", async () => {
    const storage = await makeStorage();
    await setRelayBaseUrl(storage, "https://my-relay.example.com");
    expect(await getRelayBaseUrl(storage)).toBe("https://my-relay.example.com");
  });

  it("rejects malformed URLs", async () => {
    const storage = await makeStorage();
    await expect(setRelayBaseUrl(storage, "not a url")).rejects.toThrow();
  });

  it("mints + reuses a 22-char base64url device auth token", async () => {
    const storage = await makeStorage();
    const first = await ensureDeviceAuthToken(storage);
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const second = await ensureDeviceAuthToken(storage);
    expect(second).toBe(first);
  });
});
