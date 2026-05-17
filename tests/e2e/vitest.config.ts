import { defineConfig } from "vitest/config";

// E2E harness for the relay (issue #31). Runs in Node — NOT in the Workers
// vitest pool — because @defer/core's crypto module depends on libsodium's
// runtime WASM compilation, which workerd blocks (`WebAssembly.instantiate()`
// is disallowed by the embedder in the test pool). The relay itself runs
// inside a real Miniflare-hosted workerd via `wrangler unstable_dev`, so the
// transport boundary is exercised end-to-end over HTTP rather than via an
// in-process binding.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Spinning up wrangler dev takes a few seconds per worker; one worker for
    // the whole suite means a single boot.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Each test runs serially against the shared dev worker — they use fresh
    // vault IDs so cross-test bleed is impossible, but the bootstrap is slow
    // so we don't want a 30-second timeout fighting an in-flight start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
