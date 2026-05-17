import type { ExecutionContext } from "@cloudflare/workers-types";

import type { Env } from "./env.js";
import { createApp } from "./relay-api.js";

export { VaultRelay } from "./vault-relay.js";

// Worker entrypoint. Hono's `fetch` is `(req, env, ctx) => Promise<Response>`,
// which is exactly the Cloudflare Worker signature. We construct a fresh app
// per request so per-request state can't leak between invocations; Hono is
// cheap enough that the allocation cost is negligible.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = createApp(env);
    return app.fetch(request, env, ctx);
  },
};
