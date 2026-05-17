import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// The pool runs vitest specs inside a Miniflare Worker — the same V8 isolate
// runtime production uses. That's the Cloudflare-blessed test harness; rolling
// our own would mean re-implementing DO and KV semantics in node. We point at
// the same `wrangler.toml` the production worker uses so bindings (DO, KV,
// vars) flow through unchanged.
export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // The wrangler [vars] placeholder is fine for tests; the log HMAC
          // here is what the logging.test.ts asserts against.
          bindings: {
            LOG_HMAC_SECRET: "dev-secret-for-tests",
            CORS_ALLOWED_ORIGINS: "",
          },
        },
      },
    },
  },
});
