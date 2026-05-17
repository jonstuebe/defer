import { describe, expect, it } from "vitest";

import { apply, initialVaultState } from "../index.js";
import type { Event } from "../../events/index.js";

const CLIENT_NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

describe("forward-compatibility", () => {
  it('an event with type "UnknownInTheFuture" is identity-equal on apply', () => {
    const s0 = initialVaultState();
    const futureEvent = {
      type: "UnknownInTheFuture",
      seq: 1,
      deviceId: "device-abc",
      timestamp: 1_700_000_000_000,
      clientNonce: CLIENT_NONCE,
      data: { something: "new" },
    } as unknown as Event;

    const s1 = apply(s0, futureEvent);
    expect(Object.is(s1, s0)).toBe(true);
  });

  it("an unknown event applied to a populated state still returns the input identity-equal", () => {
    let s = initialVaultState();
    s = apply(s, {
      type: "ItemSaved",
      seq: 1,
      deviceId: "device-abc",
      timestamp: 1_700_000_000_000,
      clientNonce: CLIENT_NONCE,
      data: {
        itemId: "i1",
        url: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        title: "x",
        savedAt: 1,
      },
    });

    const before = s;
    const futureEvent = {
      type: "UnknownInTheFuture",
      seq: 2,
      deviceId: "device-abc",
      timestamp: 1_700_000_000_500,
      clientNonce: CLIENT_NONCE,
      data: {},
    } as unknown as Event;
    const after = apply(s, futureEvent);
    expect(Object.is(after, before)).toBe(true);
  });
});
