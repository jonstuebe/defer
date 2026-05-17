import { z } from "zod";

import {
  ErrorEnvelopeSchema,
  PushEventsRequestSchema,
  PushEventsResponseSchema,
  type PushEventsResponse,
} from "../relay-protocol/index.js";
import type { PendingEvent } from "../events/index.js";

import { RelayError, RelayProtocolError, RelayResponseShapeError } from "./errors.js";

/**
 * Permissive pull-response envelope used by the client. The relay validates
 * events strictly when serving (via `PullEventsResponseSchema` in
 * `relay-protocol/wire.ts`), but the *client* deliberately defers per-event
 * validation to `InboundReplay`. Two reasons:
 *
 * - Forward-compat with new event types added to a newer relay before the
 *   client catches up — per ADR-0002, unknown event types must be silently
 *   skipped by the reducer; strict client-side validation here would
 *   abort the whole pull on the first unknown type, defeating that.
 * - Isolation of a single malformed event from the rest of the page —
 *   if one event fails our schema, the others should still apply.
 */
const PullEventsResponseEnvelopeSchema = z.object({
  events: z.array(z.unknown()),
  nextSince: z.number().int().nonnegative().nullable(),
});

export type PullEventsRawResponse = z.infer<typeof PullEventsResponseEnvelopeSchema>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RelayClientOpts = {
  /** Base URL of the relay — e.g. `https://relay.defer.example`. No trailing slash. */
  baseUrl: string;
  /** 22-char base64url vault ID (HKDF-derived from the vault key). */
  vaultIdBase64Url: string;
  /** 22-char base64url device auth token. */
  bearerToken: string;
  /** Custom fetch impl. Defaults to `globalThis.fetch`. Useful for tests + Tauri. */
  fetch?: FetchLike;
};

/**
 * HTTP wrapper around the relay's `/v1/vault/:vaultId/events` endpoints. The
 * client is intentionally thin — it doesn't retry, doesn't decide batch
 * sizes, and doesn't manage the pending-event queue. Those concerns live in
 * `outboundFlush` / `inboundReplay`, which compose on top of this. Pinning
 * scopes that narrowly means the wire format lives in one place and every
 * caller goes through the same Zod-validated boundary.
 *
 * The first POST from a previously-unseen `vaultId` triggers **Vault
 * bootstrap** at the relay (ADR-0007 §1) — the bearer token in the request
 * is registered as the vault's first valid device auth token. No special
 * client-side handling is required; bootstrap is an emergent property of
 * the relay's "unknown vault + valid envelope ⇒ initialize" rule.
 */
export class RelayClient {
  readonly #baseUrl: string;
  readonly #vaultId: string;
  readonly #bearer: string;
  readonly #fetch: FetchLike;

  constructor(opts: RelayClientOpts) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#vaultId = opts.vaultIdBase64Url;
    this.#bearer = opts.bearerToken;
    this.#fetch =
      opts.fetch ??
      ((input, init) => {
        if (typeof globalThis.fetch !== "function") {
          throw new Error("RelayClient: globalThis.fetch is undefined; pass `fetch` in opts");
        }
        return globalThis.fetch(input, init);
      });
  }

  /**
   * Pushes one or more pending (pre-`seq`) events to the relay. Returns the
   * relay-assigned `seq` for each event, in the same order as the request.
   *
   * Re-POSTing an event with the same `(deviceId, clientNonce)` is safe —
   * the relay rejects the duplicate as `409 DUPLICATE_CLIENT_NONCE` per
   * ADR-0006 §4.2. Callers should treat that code as "already synced" and
   * mark the pending entry done.
   */
  async pushEvents(events: PendingEvent[]): Promise<PushEventsResponse> {
    if (events.length === 0) {
      throw new RangeError("RelayClient.pushEvents: events must be non-empty");
    }
    const body = PushEventsRequestSchema.parse({ events });
    const response = await this.#request(`/v1/vault/${this.#vaultId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.#decode(response, PushEventsResponseSchema);
  }

  /**
   * Pulls events with `seq > since`, capped at the relay's page size
   * (`MAX_PAGE_SIZE` per `relay-protocol/wire.ts`). When `nextSince` in the
   * response is non-null the caller should keep paging from that value.
   */
  async pullEvents(since: number): Promise<PullEventsRawResponse> {
    if (!Number.isInteger(since) || since < 0) {
      throw new RangeError("RelayClient.pullEvents: since must be a non-negative integer");
    }
    const url = `/v1/vault/${this.#vaultId}/events?since=${since}`;
    const response = await this.#request(url, { method: "GET" });
    return this.#decode(response, PullEventsResponseEnvelopeSchema);
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#bearer}`);
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (response.ok) return response;

    // Non-2xx — try to parse the envelope. If it doesn't match, surface
    // RelayProtocolError so callers can tell "relay refused us cleanly"
    // (RelayError) from "relay is broken / wrong version" (RelayProtocolError).
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      throw new RelayProtocolError(response.status, "<unreadable response body>");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      throw new RelayProtocolError(response.status, bodyText.slice(0, 200));
    }
    const envelope = ErrorEnvelopeSchema.safeParse(parsedJson);
    if (!envelope.success) {
      throw new RelayProtocolError(response.status, bodyText.slice(0, 200));
    }
    throw new RelayError(envelope.data, response.status);
  }

  async #decode<T>(
    response: Response,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: { issues: unknown } };
    },
  ): Promise<T> {
    const bodyText = await response.text();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      throw new RelayResponseShapeError(`response was not valid JSON: ${bodyText.slice(0, 200)}`);
    }
    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      throw new RelayResponseShapeError(JSON.stringify(result.error.issues));
    }
    return result.data;
  }
}
