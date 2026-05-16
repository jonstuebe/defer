import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { apply, initialVaultState, type VaultState } from "../index.js";
import type { Event } from "../../events/index.js";

// Turn a VaultState into a plain JSON-comparable form. Vitest's `toEqual` is
// generally Map/Set-aware, but we serialize defensively so property failures
// produce small, readable diffs.
function snapshot(state: VaultState): unknown {
  const items: Record<string, unknown> = {};
  // Sort keys for stable comparison regardless of insertion order.
  for (const id of [...state.items.keys()].sort()) {
    const item = state.items.get(id)!;
    items[id] = { ...item, tags: [...item.tags] };
  }

  const byCanonical: Record<string, string> = {};
  for (const url of [...state.itemsByCanonicalUrl.keys()].sort()) {
    byCanonical[url] = state.itemsByCanonicalUrl.get(url)!;
  }

  const devices: Record<string, unknown> = {};
  for (const id of [...state.devices.keys()].sort()) {
    devices[id] = state.devices.get(id);
  }

  return {
    items,
    itemsByCanonicalUrl: byCanonical,
    tags: [...state.tags].sort(),
    devices,
    scheduledDeletion: state.scheduledDeletion,
    isDeleted: state.isDeleted,
  };
}

function reduceAll(events: Event[]): VaultState {
  return events.reduce((s, e) => apply(s, e), initialVaultState());
}

// Arbitraries over a small fixed alphabet so events refer to overlapping ids.
const ITEM_IDS = ["i1", "i2", "i3"] as const;
const TAGS = ["alpha", "beta", "gamma"] as const;
const DEVICE_IDS = ["dev-a", "dev-b"] as const;
// Placeholder MAC. ADR-0006: base64url HMAC-SHA256 → 43 chars unpadded.
const SIG = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const itemIdArb = fc.constantFrom(...ITEM_IDS);
const tagArb = fc.constantFrom(...TAGS);
const deviceIdArb = fc.constantFrom(...DEVICE_IDS);

// Build a single event body (without seq); we'll assign unique seqs at the end.
const eventBodyArb: fc.Arbitrary<Omit<Event, "seq">> = fc.oneof(
  itemIdArb.chain((itemId) =>
    fc.record({
      type: fc.constant("ItemSaved" as const),
      deviceId: fc.constant("device-abc"),
      timestamp: fc.integer({ min: 1, max: 10_000 }),
      data: fc.record({
        itemId: fc.constant(itemId),
        url: fc.constant(`https://example.com/${itemId}`),
        canonicalUrl: fc.constant(`https://example.com/${itemId}`),
        title: fc.constant(`title-${itemId}`),
        savedAt: fc.integer({ min: 1, max: 10_000 }),
      }),
    }),
  ),
  fc.record({
    type: fc.constantFrom(
      "ItemArchived" as const,
      "ItemUnarchived" as const,
      "ItemLiked" as const,
      "ItemUnliked" as const,
      "ItemDeleted" as const,
    ),
    deviceId: fc.constant("device-abc"),
    timestamp: fc.integer({ min: 1, max: 10_000 }),
    data: fc.record({ itemId: itemIdArb }),
  }),
  fc.record({
    type: fc.constantFrom("ItemTagged" as const, "ItemUntagged" as const),
    deviceId: fc.constant("device-abc"),
    timestamp: fc.integer({ min: 1, max: 10_000 }),
    data: fc.record({ itemId: itemIdArb, tag: tagArb }),
  }),
  fc.record({
    type: fc.constant("ItemTitleEdited" as const),
    deviceId: fc.constant("device-abc"),
    timestamp: fc.integer({ min: 1, max: 10_000 }),
    data: fc.record({
      itemId: itemIdArb,
      title: fc.string({ maxLength: 16 }),
    }),
  }),
  deviceIdArb.chain((deviceId) =>
    fc.record({
      type: fc.constant("DeviceRegistered" as const),
      deviceId: fc.constant("device-abc"),
      timestamp: fc.integer({ min: 1, max: 10_000 }),
      data: fc.record({
        deviceId: fc.constant(deviceId),
        deviceName: fc.constant(`name-${deviceId}`),
        deviceType: fc.constant("mobile"),
        registeredAt: fc.integer({ min: 1, max: 10_000 }),
      }),
    }),
  ),
  fc.record({
    type: fc.constant("DeviceRevoked" as const),
    deviceId: fc.constant("device-abc"),
    timestamp: fc.integer({ min: 1, max: 10_000 }),
    data: fc.record({ deviceId: deviceIdArb }),
  }),
);

const eventSequenceArb: fc.Arbitrary<Event[]> = fc
  .array(eventBodyArb, { minLength: 0, maxLength: 30 })
  .map((bodies) =>
    bodies.map((body, i): Event => ({ ...(body as Omit<Event, "seq">), seq: i + 1 }) as Event),
  );

function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  // Deterministic Fisher-Yates with a tiny xorshift PRNG.
  let s = seed | 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const j = Math.abs(s) % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

describe("projection — property: seq order matters for non-commutative events", () => {
  // The reducer's correctness hinges on clients applying events in `seq` order
  // (ADR-0002). This property demonstrates that the seq order is load-bearing
  // by constructing two interleavings of the same events that produce
  // observably different final state when applied in input-array order — and
  // verifying that sorting by `seq` first collapses both to the same result.
  it("ItemSaved before ItemArchived (seq order) leaves item archived; reversed input order, sorted by seq, agrees", () => {
    fc.assert(
      fc.property(itemIdArb, fc.integer({ min: 1, max: 1000 }), (itemId, ts) => {
        const saved: Event = {
          type: "ItemSaved",
          seq: 1,
          deviceId: "device-abc",
          timestamp: ts,
          data: {
            itemId,
            url: `https://example.com/${itemId}`,
            canonicalUrl: `https://example.com/${itemId}`,
            title: "",
            savedAt: ts,
          },
        };
        const archived: Event = {
          type: "ItemArchived",
          seq: 2,
          deviceId: "device-abc",
          timestamp: ts + 1,
          data: { itemId },
        };

        // 1. Input order matches seq order — archive lands.
        const forward = reduceAll([saved, archived]);
        expect(forward.items.get(itemId)?.state).toBe("archive");

        // 2. Input order is reversed (archive before save) — without sorting,
        //    the archive targets a non-existent item and is a no-op; the item
        //    ends up in inbox. This is the "ordering matters" demonstration.
        const reversedNaive = reduceAll([archived, saved]);
        expect(reversedNaive.items.get(itemId)?.state).toBe("inbox");
        expect(snapshot(reversedNaive)).not.toEqual(snapshot(forward));

        // 3. The same reversed input, sorted by seq before reducing, agrees
        //    with the canonical forward result. This is the contract the
        //    rest of the system relies on.
        const reversedSorted = reduceAll([archived, saved].sort((a, b) => a.seq - b.seq));
        expect(snapshot(reversedSorted)).toEqual(snapshot(forward));
      }),
    );
  });

  it("any permutation of a unique-seq event sequence, sorted by seq, reduces to the canonical result", () => {
    // Weaker companion to the above: confirms that for *any* generated
    // sequence (where seqs are unique by construction), applying after seq
    // sort is permutation-invariant. The non-trivial work is done by the
    // first property; this one guards the canonical sort step itself.
    fc.assert(
      fc.property(eventSequenceArb, fc.integer(), (events, seed) => {
        const canonical = reduceAll([...events].sort((a, b) => a.seq - b.seq));
        const permuted = reduceAll(shuffle(events, seed).sort((a, b) => a.seq - b.seq));
        expect(snapshot(permuted)).toEqual(snapshot(canonical));
      }),
    );
  });
});

describe("projection — property: tag/like idempotency & commutativity", () => {
  it("applying ItemTagged N times is the same as applying it once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), tagArb, itemIdArb, (n, tag, itemId) => {
        let s = initialVaultState();
        s = apply(s, {
          type: "ItemSaved",
          seq: 1,
          deviceId: "device-abc",
          timestamp: 1,
          data: {
            itemId,
            url: `https://example.com/${itemId}`,
            canonicalUrl: `https://example.com/${itemId}`,
            title: "",
            savedAt: 1,
          },
        });
        const once = apply(s, {
          type: "ItemTagged",
          seq: 2,
          deviceId: "device-abc",
          timestamp: 2,
          data: { itemId, tag },
        });
        let many = s;
        for (let i = 0; i < n; i++) {
          many = apply(many, {
            type: "ItemTagged",
            seq: 2 + i,
            deviceId: "device-abc",
            timestamp: 2 + i,
            data: { itemId, tag },
          });
        }
        expect(snapshot(many)).toEqual(snapshot(once));
      }),
    );
  });

  it("ItemLiked applied repeatedly is the same as applied once", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), itemIdArb, (n, itemId) => {
        let s = initialVaultState();
        s = apply(s, {
          type: "ItemSaved",
          seq: 1,
          deviceId: "device-abc",
          timestamp: 1,
          data: {
            itemId,
            url: `https://example.com/${itemId}`,
            canonicalUrl: `https://example.com/${itemId}`,
            title: "",
            savedAt: 1,
          },
        });
        const once = apply(s, {
          type: "ItemLiked",
          seq: 2,
          deviceId: "device-abc",
          timestamp: 2,
          data: { itemId },
        });
        let many = s;
        for (let i = 0; i < n; i++) {
          many = apply(many, {
            type: "ItemLiked",
            seq: 2 + i,
            deviceId: "device-abc",
            timestamp: 2 + i,
            data: { itemId },
          });
        }
        expect(snapshot(many)).toEqual(snapshot(once));
      }),
    );
  });

  it("a tag/like prelude in any order is wiped out by a deterministic final sequence", () => {
    // Apply any permutation of [Tagged(t), Untagged(t), Liked, Unliked] as a
    // prelude, then apply a fixed final ordered sequence. The result must
    // equal applying just the final sequence to a freshly-seeded state.
    const itemId = "i1";
    const tag = "alpha";
    const preludeArb = fc
      .shuffledSubarray(
        [
          { type: "ItemTagged", data: { itemId, tag } } as const,
          { type: "ItemUntagged", data: { itemId, tag } } as const,
          { type: "ItemLiked", data: { itemId } } as const,
          { type: "ItemUnliked", data: { itemId } } as const,
        ],
        { minLength: 0, maxLength: 4 },
      )
      .map((arr) => [...arr]);

    fc.assert(
      fc.property(preludeArb, (prelude) => {
        const seed: Event = {
          type: "ItemSaved",
          seq: 1,
          deviceId: "device-abc",
          timestamp: 1,
          data: {
            itemId,
            url: `https://example.com/${itemId}`,
            canonicalUrl: `https://example.com/${itemId}`,
            title: "",
            savedAt: 1,
          },
        };
        // Final ordered, deterministic sequence over the same fields.
        const final: Event[] = [
          {
            type: "ItemTagged",
            seq: 100,
            deviceId: "device-abc",
            timestamp: 100,
            data: { itemId, tag },
          },
          {
            type: "ItemLiked",
            seq: 101,
            deviceId: "device-abc",
            timestamp: 101,
            data: { itemId },
          },
        ];

        const withPrelude: Event[] = [
          seed,
          ...prelude.map(
            (p, i): Event =>
              ({
                ...p,
                seq: 2 + i,
                deviceId: "device-abc",
                timestamp: 2 + i,
              }) as Event,
          ),
          ...final,
        ];
        const withoutPrelude: Event[] = [seed, ...final];

        expect(snapshot(reduceAll(withPrelude))).toEqual(snapshot(reduceAll(withoutPrelude)));
      }),
    );
  });

  it("VaultDeleted is a sink: any subsequent events leave isDeleted = true and no other change", () => {
    fc.assert(
      fc.property(eventSequenceArb, (tail) => {
        const killed = apply(initialVaultState(), {
          type: "VaultDeleted",
          seq: 1,
          deviceId: "device-abc",
          timestamp: 1,
          signature: SIG,
          data: { deletedAt: 1 },
        });
        const after = tail.reduce((s, e) => apply(s, e), killed);
        // No-op semantics imply identity-equal, but at minimum the snapshot
        // must be deep-equal to the killed-only snapshot.
        expect(snapshot(after)).toEqual(snapshot(killed));
        expect(after.isDeleted).toBe(true);
      }),
    );
  });
});
