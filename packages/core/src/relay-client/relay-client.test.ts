import { describe, expect, it, vi } from "vitest";

import { RelayClient } from "./relay-client.js";
import { RelayProtocolError, RelayResponseShapeError } from "./errors.js";

type FetchMock = ReturnType<typeof vi.fn>;

function makeClient(fetchImpl: FetchMock) {
  return new RelayClient({
    baseUrl: "https://relay.example/",
    vaultIdBase64Url: "AAAAAAAAAAAAAAAAAAAAAA",
    bearerToken: "BBBBBBBBBBBBBBBBBBBBBB",
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RelayClient.pushEvents", () => {
  it("POSTs to /v1/vault/:vaultId/events with bearer + body and returns assigned seqs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ assigned: [1, 2] }));
    const client = makeClient(fetchMock);

    const response = await client.pushEvents([
      {
        type: "ItemSaved",
        deviceId: "device-AAAAAAAAAAAAA",
        timestamp: 100,
        clientNonce: "CCCCCCCCCCCCCCCCCCCCCC",
        data: {
          itemId: "item-1",
          url: "https://example.com/",
          canonicalUrl: "https://example.com/",
          title: "",
          savedAt: 100,
        },
      },
      {
        type: "ItemArchived",
        deviceId: "device-AAAAAAAAAAAAA",
        timestamp: 101,
        clientNonce: "DDDDDDDDDDDDDDDDDDDDDD",
        data: { itemId: "item-1" },
      },
    ]);

    expect(response.assigned).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://relay.example/v1/vault/AAAAAAAAAAAAAAAAAAAAAA/events");
    expect((init as RequestInit).method).toBe("POST");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Authorization")).toBe("Bearer BBBBBBBBBBBBBBBBBBBBBB");
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
  });

  it("throws RelayError on a typed error envelope", async () => {
    const envelope = {
      error: "conflict",
      code: "DUPLICATE_CLIENT_NONCE",
      requestId: "01926bdb-c001-7000-8000-000000000001",
      details: { eventIndex: 0 },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(envelope, 409));
    const client = makeClient(fetchMock);

    await expect(
      client.pushEvents([
        {
          type: "ItemArchived",
          deviceId: "device-AAAAAAAAAAAAA",
          timestamp: 1,
          clientNonce: "EEEEEEEEEEEEEEEEEEEEEE",
          data: { itemId: "item-1" },
        },
      ]),
    ).rejects.toMatchObject({
      name: "RelayError",
      code: "DUPLICATE_CLIENT_NONCE",
      status: 409,
      requestId: "01926bdb-c001-7000-8000-000000000001",
    });
  });

  it("throws RelayProtocolError on a non-envelope error body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>500</html>", { status: 500 }));
    const client = makeClient(fetchMock);

    await expect(
      client.pushEvents([
        {
          type: "ItemArchived",
          deviceId: "device-AAAAAAAAAAAAA",
          timestamp: 1,
          clientNonce: "FFFFFFFFFFFFFFFFFFFFFF",
          data: { itemId: "item-1" },
        },
      ]),
    ).rejects.toBeInstanceOf(RelayProtocolError);
  });

  it("throws RelayResponseShapeError on a 2xx with malformed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ not: "what we expected" }));
    const client = makeClient(fetchMock);

    await expect(
      client.pushEvents([
        {
          type: "ItemArchived",
          deviceId: "device-AAAAAAAAAAAAA",
          timestamp: 1,
          clientNonce: "GGGGGGGGGGGGGGGGGGGGGG",
          data: { itemId: "item-1" },
        },
      ]),
    ).rejects.toBeInstanceOf(RelayResponseShapeError);
  });

  it("rejects an empty batch up-front (does not hit the network)", async () => {
    const fetchMock = vi.fn();
    const client = makeClient(fetchMock);
    await expect(client.pushEvents([])).rejects.toThrow(/non-empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RelayClient.pullEvents", () => {
  it("GETs /events?since=N and parses the response", async () => {
    const responseBody = { events: [], nextSince: null };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(responseBody));
    const client = makeClient(fetchMock);

    const result = await client.pullEvents(42);
    expect(result.events).toEqual([]);
    expect(result.nextSince).toBeNull();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://relay.example/v1/vault/AAAAAAAAAAAAAAAAAAAAAA/events?since=42");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("rejects negative or non-integer since", async () => {
    const client = makeClient(vi.fn());
    await expect(client.pullEvents(-1)).rejects.toThrow();
    await expect(client.pullEvents(1.5)).rejects.toThrow();
  });
});

describe("RelayClient transport errors", () => {
  it("propagates fetch transport failures verbatim (caller decides retry)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    const client = makeClient(fetchMock);
    await expect(client.pullEvents(0)).rejects.toThrow(/offline/);
  });
});
