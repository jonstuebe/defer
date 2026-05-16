import sodium from "libsodium-wrappers-sumo";

let initialized = false;

export const ready: Promise<void> = sodium.ready.then(() => {
  initialized = true;
});

export function assertReady(): void {
  if (!initialized) {
    throw new Error(
      "@defer/core/crypto: libsodium is not initialized. `await ready` from @defer/core/crypto before calling any crypto primitive.",
    );
  }
}

export { sodium };
