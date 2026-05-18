import { describe, expect, it, vi } from "vitest";

import { copyWithAutoClear, type ClipboardDeps } from "./auto-clear.js";

function makeDeps(): {
  deps: ClipboardDeps;
  writes: string[];
  fireTimer: () => void;
  cancelled: boolean[];
} {
  const writes: string[] = [];
  let pending: { handler: () => void } | null = null;
  const cancelled: boolean[] = [];
  const deps: ClipboardDeps = {
    async write(text) {
      writes.push(text);
    },
    setTimer(handler) {
      pending = { handler };
      return pending as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer() {
      cancelled.push(true);
      pending = null;
    },
  };
  return {
    deps,
    writes,
    fireTimer: () => {
      pending?.handler();
    },
    cancelled,
  };
}

describe("copyWithAutoClear", () => {
  it("writes the text immediately and overwrites it after the timer fires", async () => {
    const { deps, writes, fireTimer } = makeDeps();
    await copyWithAutoClear("the words", deps);
    expect(writes).toEqual(["the words"]);
    fireTimer();
    // The clear write is fire-and-forget — yield once to let the microtask
    // queue drain before we assert on it.
    await Promise.resolve();
    expect(writes).toEqual(["the words", ""]);
  });

  it("supports cancellation before the timer fires", async () => {
    const { deps, writes, cancelled } = makeDeps();
    const handle = await copyWithAutoClear("secret", deps);
    handle.cancel();
    expect(cancelled).toEqual([true]);
    expect(writes).toEqual(["secret"]);
  });

  it("propagates write errors from the underlying clipboard", async () => {
    const deps: ClipboardDeps = {
      async write() {
        throw new Error("permission denied");
      },
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    };
    await expect(copyWithAutoClear("x", deps)).rejects.toThrow(/permission denied/);
  });
});
