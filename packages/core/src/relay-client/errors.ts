import type { ErrorCode, ErrorEnvelope } from "../relay-protocol/index.js";

/**
 * Typed error thrown by `RelayClient` when the relay responds with a non-2xx
 * status. Carries the parsed error envelope (ADR-0007 §2) so callers can
 * pattern-match on `code` for retry semantics rather than parse the HTTP
 * status. The envelope's `requestId` is preserved verbatim so logs on both
 * sides can be correlated.
 *
 * Construction is gated through the static `fromResponse` factory so callers
 * cannot accidentally instantiate without an envelope — a relay error that
 * is not envelope-shaped is a protocol violation, surfaced as a different
 * error class (`RelayProtocolError`) below.
 */
export class RelayError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope, status: number) {
    super(`relay ${status} ${envelope.code}: ${envelope.error}`);
    this.name = "RelayError";
    this.code = envelope.code;
    this.status = status;
    this.requestId = envelope.requestId;
    this.envelope = envelope;
  }
}

/**
 * Thrown when the relay returns a non-2xx response whose body does NOT match
 * the documented `ErrorEnvelope` shape. Distinguishing this from `RelayError`
 * matters: a malformed error response is a protocol violation, not a regular
 * relay failure mode, and shouldn't be retried the same way (the relay may
 * be reachable but speaking a different protocol version).
 */
export class RelayProtocolError extends Error {
  readonly status: number;
  readonly bodySnippet: string;

  constructor(status: number, bodySnippet: string) {
    super(`relay returned a non-envelope ${status} response`);
    this.name = "RelayProtocolError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/**
 * Thrown when the relay's 2xx response body does NOT match the response
 * schema (e.g., `PushEventsResponseSchema`). Same protocol-mismatch concern
 * as `RelayProtocolError` — the relay is reachable but speaking a shape we
 * don't recognise.
 */
export class RelayResponseShapeError extends Error {
  readonly issues: string;

  constructor(issues: string) {
    super(`relay response failed schema validation: ${issues}`);
    this.name = "RelayResponseShapeError";
    this.issues = issues;
  }
}
