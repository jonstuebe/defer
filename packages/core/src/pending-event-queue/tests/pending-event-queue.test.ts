import { describe, expect, it } from "vitest";
import {
  InMemoryStoragePort,
  PendingEventQueue,
  type PendingEventQueueEntry,
  type StoragePort,
} from "../index.js";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe("PendingEventQueue", () => {
  it("round trip: enqueue then markSynced empties the queue", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    expect(await queue.size()).toBe(0);

    const entry = await queue.enqueue(bytes(1, 2, 3));
    expect(await queue.size()).toBe(1);

    const peeked = await queue.peek();
    expect(peeked).toHaveLength(1);
    expect(peeked[0]!.id).toBe(entry.id);
    expect(Array.from(peeked[0]!.event)).toEqual([1, 2, 3]);

    await queue.markSynced([entry.id]);
    expect(await queue.peek()).toEqual([]);
    expect(await queue.size()).toBe(0);
  });

  it("partial sync returns remaining entries in enqueue order", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const entries: PendingEventQueueEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      entries.push(await queue.enqueue(bytes(i)));
    }
    const firstThreeIds = entries.slice(0, 3).map((e) => e.id);
    await queue.markInFlight(firstThreeIds);
    await queue.markSynced(firstThreeIds);

    const remaining = await queue.peek();
    expect(remaining.map((e) => e.id)).toEqual([entries[3]!.id, entries[4]!.id]);
  });

  it("markFailed keeps the entry visible and increments attemptCount", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const entry = await queue.enqueue(bytes(9));
    await queue.markFailed([entry.id]);

    const peeked = await queue.peek();
    expect(peeked).toHaveLength(1);
    expect(peeked[0]!.attemptCount).toBe(1);
    expect(peeked[0]!.status).toBe("failed");
    expect(peeked[0]!.lastAttemptAt).not.toBeNull();
  });

  it("markFailed twice increments attemptCount to 2", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const entry = await queue.enqueue(bytes(9));
    await queue.markFailed([entry.id]);
    await queue.markFailed([entry.id]);

    const peeked = await queue.peek();
    expect(peeked[0]!.attemptCount).toBe(2);
  });

  it("survives reconstruction from the same storage", async () => {
    const storage = new InMemoryStoragePort();
    const queueA = new PendingEventQueue(storage);
    const entry = await queueA.enqueue(bytes(7, 8, 9));

    const queueB = new PendingEventQueue(storage);
    const peeked = await queueB.peek();
    expect(peeked).toHaveLength(1);
    expect(peeked[0]!.id).toBe(entry.id);
    expect(Array.from(peeked[0]!.event)).toEqual([7, 8, 9]);

    await queueB.markSynced([entry.id]);
    expect(await queueB.size()).toBe(0);
  });

  it("resets in-flight entries to pending on reconstruction", async () => {
    const storage = new InMemoryStoragePort();
    const queueA = new PendingEventQueue(storage);
    const enqueued: PendingEventQueueEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      enqueued.push(await queueA.enqueue(bytes(i)));
    }
    const allIds = enqueued.map((e) => e.id);
    await queueA.markInFlight(allIds);
    await queueA.markSynced(allIds.slice(0, 3));

    const queueB = new PendingEventQueue(storage);
    const peeked = await queueB.peek();
    expect(peeked.map((e) => e.id)).toEqual([enqueued[3]!.id, enqueued[4]!.id]);
    expect(peeked.every((e) => e.status === "pending")).toBe(true);
  });

  it("retries hydration after a transient storage.read failure", async () => {
    let attempt = 0;
    const inner = new InMemoryStoragePort();
    const flaky: StoragePort = {
      async read() {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("transient");
        }
        return inner.read();
      },
      async write(entries) {
        return inner.write(entries);
      },
    };

    const queue = new PendingEventQueue(flaky);
    await expect(queue.size()).rejects.toThrow("transient");
    // second call should retry hydration and succeed
    expect(await queue.size()).toBe(0);
  });

  it("enqueue assigns unique UUIDs", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const a = await queue.enqueue(bytes(1));
    const b = await queue.enqueue(bytes(2));
    const c = await queue.enqueue(bytes(3));
    const ids = new Set([a.id, b.id, c.id]);
    expect(ids.size).toBe(3);
  });

  it("defensive copy on enqueue: mutating input does not affect stored bytes", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const input = bytes(1, 2, 3);
    const entry = await queue.enqueue(input);
    input[0] = 99;

    const peeked = await queue.peek();
    expect(Array.from(peeked[0]!.event)).toEqual([1, 2, 3]);
    expect(entry.event[0]).toBe(1);
  });

  it("defensive copy on peek: mutating returned bytes does not affect storage", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    await queue.enqueue(bytes(1, 2, 3));
    const first = await queue.peek();
    first[0]!.event[0] = 99;

    const second = await queue.peek();
    expect(Array.from(second[0]!.event)).toEqual([1, 2, 3]);
  });

  it("defensive copy on enqueue return: mutating returned entry does not affect storage", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const returned = await queue.enqueue(bytes(1, 2, 3));
    returned.event[0] = 99;

    const peeked = await queue.peek();
    expect(Array.from(peeked[0]!.event)).toEqual([1, 2, 3]);
  });

  it("peek does not return in-flight entries", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const entry = await queue.enqueue(bytes(1));
    await queue.markInFlight([entry.id]);
    expect(await queue.peek()).toEqual([]);
  });

  it("peek with a limit returns at most that many entries", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const enqueued: PendingEventQueueEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      enqueued.push(await queue.enqueue(bytes(i)));
    }
    const peeked = await queue.peek(2);
    expect(peeked.map((e) => e.id)).toEqual([enqueued[0]!.id, enqueued[1]!.id]);
  });

  it("markInFlight silently ignores unknown ids", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    await expect(queue.markInFlight(["does-not-exist"])).resolves.toBeUndefined();
  });

  it("markSynced silently ignores unknown ids", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    await expect(queue.markSynced(["does-not-exist"])).resolves.toBeUndefined();
  });

  it("markFailed silently ignores unknown ids", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    await expect(queue.markFailed(["does-not-exist"])).resolves.toBeUndefined();
  });

  it("size counts entries across all statuses", async () => {
    const queue = new PendingEventQueue(new InMemoryStoragePort());
    const a = await queue.enqueue(bytes(1));
    const b = await queue.enqueue(bytes(2));
    await queue.enqueue(bytes(3));
    await queue.markInFlight([a.id]);
    await queue.markFailed([b.id]);
    expect(await queue.size()).toBe(3);
  });

  it("works with an async-delayed storage backend", async () => {
    const inner = new InMemoryStoragePort();
    const delayed: StoragePort = {
      async read() {
        await new Promise((r) => setTimeout(r, 0));
        return inner.read();
      },
      async write(entries) {
        await new Promise((r) => setTimeout(r, 0));
        return inner.write(entries);
      },
    };

    const queueA = new PendingEventQueue(delayed);
    const entry = await queueA.enqueue(bytes(1, 2, 3));
    await queueA.markFailed([entry.id]);

    const queueB = new PendingEventQueue(delayed);
    const peeked = await queueB.peek();
    expect(peeked).toHaveLength(1);
    expect(peeked[0]!.id).toBe(entry.id);
    expect(peeked[0]!.status).toBe("failed");
    expect(peeked[0]!.attemptCount).toBe(1);
  });

  it("flush() awaits all queued mutations", async () => {
    const writes: number[] = [];
    const storage: StoragePort = {
      async read() {
        return [];
      },
      async write(entries) {
        await new Promise((r) => setTimeout(r, 1));
        writes.push(entries.length);
      },
    };
    const queue = new PendingEventQueue(storage);
    void queue.enqueue(bytes(1));
    void queue.enqueue(bytes(2));
    void queue.enqueue(bytes(3));
    await queue.flush();
    expect(writes).toEqual([1, 2, 3]);
  });

  it("serialises concurrent mutations so storage observes writes in order", async () => {
    // Each `write(entries)` records the length of the snapshot. If mutations
    // run concurrently their writes can interleave and storage will observe
    // out-of-order lengths (e.g. [1, 1, 3, 2, 5]). With the write chain, the
    // observed sequence must be strictly monotonic: [1, 2, 3, 4, 5].
    const calls: number[] = [];
    const storage: StoragePort = {
      async read() {
        return [];
      },
      async write(entries) {
        await new Promise((r) => setTimeout(r, 1));
        calls.push(entries.length);
      },
    };

    const queue = new PendingEventQueue(storage);
    await Promise.all([
      queue.enqueue(bytes(1)),
      queue.enqueue(bytes(2)),
      queue.enqueue(bytes(3)),
      queue.enqueue(bytes(4)),
      queue.enqueue(bytes(5)),
    ]);

    expect(calls).toEqual([1, 2, 3, 4, 5]);
  });
});
