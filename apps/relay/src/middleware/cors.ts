import type { MiddlewareHandler } from "hono";

// CORS policy pinned by ADR-0007 §3:
//   - Echo `Origin` if it matches the allowlist; omit otherwise.
//   - Methods: GET, POST, DELETE, OPTIONS
//   - Headers: Authorization, Content-Type, X-Request-Id
//   - No `Access-Control-Allow-Credentials`.
//   - Max-Age: 600 (10 minutes).
//
// The default allowlist is compiled in (no `https://*`). Operators add
// production web origins via the `CORS_ALLOWED_ORIGINS` env var (comma-
// separated exact match) so a misconfigured fork can't accidentally serve
// `Allow-Origin: *` to arbitrary web pages.

const DEFAULT_SCHEME_GLOBS = ["chrome-extension://", "safari-web-extension://", "tauri://"];

const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type, X-Request-Id";
const MAX_AGE_SECONDS = "600";

export interface CorsOptions {
  allowedOriginsEnv?: string | undefined;
}

function parseEnvAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Returns true if `origin` matches one of the compiled-in scheme globs
 * (chrome-extension://*, safari-web-extension://*, tauri://*) OR an entry in
 * the comma-separated env-configured exact-match list. Wildcards inside the
 * env list are intentionally NOT supported — those would let a fork
 * accidentally allow arbitrary web origins.
 */
export function isAllowedOrigin(origin: string, envList: readonly string[]): boolean {
  for (const scheme of DEFAULT_SCHEME_GLOBS) {
    if (origin.startsWith(scheme)) return true;
  }
  for (const exact of envList) {
    if (origin === exact) return true;
  }
  return false;
}

export const cors = (opts: CorsOptions = {}): MiddlewareHandler => {
  const envList = parseEnvAllowlist(opts.allowedOriginsEnv);

  return async (c, next) => {
    const origin = c.req.header("origin");
    const isPreflight = c.req.method === "OPTIONS";

    if (origin !== undefined && isAllowedOrigin(origin, envList)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }

    if (isPreflight) {
      // Always emit method/header advertisement on preflight, regardless of
      // whether the Origin is allowed — the absence of the Allow-Origin
      // header is what the browser uses to block; the methods/headers are
      // informational.
      c.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
      c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      c.header("Access-Control-Max-Age", MAX_AGE_SECONDS);
      // 204 No Content is conventional for preflight; body would be ignored.
      return c.body(null, 204);
    }

    await next();
  };
};
