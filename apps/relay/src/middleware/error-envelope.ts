import type { Context, ErrorHandler } from "hono";
import { ZodError } from "zod";

import { categoryForCode, RelayError, statusForCode } from "../errors.js";
import type { ErrorCode } from "@defer/core/relay-protocol";

// Normalises every thrown error to the JSON shape pinned by ADR-0007 §2:
//
//   { "error": "<category>", "code": "<CLOSED_ENUM>", "requestId": "<uuidv7>" }
//
// The status code comes from ERROR_CODES (the closed enum's canonical
// status). The handler always emits `Content-Type: application/json` and
// echoes the request id on `X-Request-Id`.
//
// Registered as `app.onError(...)` rather than middleware so Hono routes
// thrown errors here BEFORE its default 500-text response runs. (OPTIONS
// preflight requests never reach this handler because the CORS middleware
// terminates them with 204 first.)

interface EnvelopeBody {
  error: string;
  code: ErrorCode;
  requestId: string;
}

function buildEnvelope(code: ErrorCode, requestId: string): EnvelopeBody {
  return {
    error: categoryForCode(code),
    code,
    requestId,
  };
}

function classify(err: unknown): { code: ErrorCode; extraHeaders: Record<string, string> } {
  if (err instanceof RelayError) {
    return { code: err.code, extraHeaders: err.headers };
  }
  if (err instanceof ZodError) {
    return { code: "SCHEMA_VIOLATION", extraHeaders: {} };
  }
  return { code: "INTERNAL_ERROR", extraHeaders: {} };
}

export const errorEnvelope = (): ErrorHandler => (err, c: Context) => {
  const requestId =
    (c.get("requestId") as string | undefined) ?? "00000000-0000-7000-8000-000000000000";

  const { code, extraHeaders } = classify(err);
  if (code === "INTERNAL_ERROR") {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: "error",
        requestId,
        msg: "unhandled exception in relay handler",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const status = statusForCode(code);
  const body = buildEnvelope(code, requestId);

  for (const [name, value] of Object.entries(extraHeaders)) {
    c.header(name, value);
  }
  c.header("Content-Type", "application/json");
  c.header("X-Request-Id", requestId);
  return c.json(body, status as Parameters<typeof c.json>[1]);
};
