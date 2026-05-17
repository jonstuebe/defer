import type { DurableObjectState } from "@cloudflare/workers-types";

import type { Env } from "./env.js";

// Durable Object skeleton. Real fetch/alarm logic lands with issues #26
// (events push/pull), #29 (deletion control plane), #30 (deletion data
// plane). This class exists so the wrangler DO binding wires up end-to-end
// and so test harnesses don't have to fake the storage layer.
//
// Storage is initialised on first fetch by writing the `initialized` marker;
// later issues will refactor without redefining the skeleton.
export class VaultRelay {
  readonly #state: DurableObjectState;
  // `env` is held for future issues (#26 reads `PAIRING_TOKENS`, #30 reads
  // alarm config) — kept here as a constructor-stored reference so those
  // slices don't have to re-thread bindings through every method signature.
  // The current skeleton doesn't read from it.
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state;
    this.#env = env;
  }

  // Exposes #env to the linter so it doesn't flag the field as unused while
  // we wait for the endpoint slices to consume it. The slices that need
  // bindings will replace this with real getters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get env(): Env {
    return this.#env;
  }

  async fetch(_request: Request): Promise<Response> {
    const initialized = await this.#state.storage.get<boolean>("initialized");
    if (initialized !== true) {
      await this.#state.storage.put("initialized", true);
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: "info",
        msg: "VaultRelay.fetch is a skeleton; real routing lands in issues #26+",
      }),
    );

    return new Response(
      JSON.stringify({
        error: "internal_error",
        code: "INTERNAL_ERROR",
        requestId: "00000000-0000-7000-8000-000000000000",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  async alarm(): Promise<void> {
    // No-op skeleton. The deletion alarm (ADR-0005, ADR-0006 §5) lands with
    // issue #30.
  }
}
