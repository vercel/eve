import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initializeSessionResources,
  publishSessionDescriptor,
  sessionDirectory,
} from "#execution/session/directory.js";
import { sessionEvents } from "#execution/session/events.js";
import { createSessionResources } from "#execution/session/resources.js";
import { sessionSnapshots } from "#execution/session/snapshots.js";
import { getRunWritable } from "#internal/workflow/run-writable.js";
import { createSessionStartedEvent, stampMessageStreamEvent } from "#protocol/message.js";

const runtime = vi.hoisted(() => ({ getRun: vi.fn(), getWorld: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => runtime);

interface StoredStream {
  chunks: unknown[];
  closed: boolean;
}

const streams = new Map<string, StoredStream>();
let failWrite: string | undefined;
let pauseFlush: Promise<void> | undefined;
let reads = 0;
let cancellations = 0;

function streamKey(runId: string, namespace: string | undefined): string {
  return JSON.stringify([runId, namespace ?? null]);
}

function stored(key: string): StoredStream {
  let stream = streams.get(key);
  if (stream === undefined) {
    stream = { chunks: [], closed: false };
    streams.set(key, stream);
  }
  return stream;
}

beforeEach(() => {
  streams.clear();
  failWrite = undefined;
  pauseFlush = undefined;
  reads = 0;
  cancellations = 0;
  runtime.getWorld.mockResolvedValue({});
  runtime.getRun.mockImplementation((runId: string) => ({
    getReadable: (options: { namespace?: string; startIndex?: number } = {}) => {
      const source = stored(streamKey(runId, options.namespace));
      let index = options.startIndex ?? 0;
      if (index < 0) index = Math.max(0, source.chunks.length + index);
      const stream = new ReadableStream<unknown>(
        {
          pull(controller) {
            reads++;
            if (index < source.chunks.length)
              controller.enqueue(structuredClone(source.chunks[index++]));
            else if (source.closed) controller.close();
          },
          cancel() {
            cancellations++;
          },
        },
        { highWaterMark: 0 },
      );
      return Object.assign(stream, { getTailIndex: async () => source.chunks.length - 1 });
    },
    getWritable: async (options: { namespace?: string; ops: Promise<unknown>[] }) => {
      const key = streamKey(runId, options.namespace);
      const source = stored(key);
      const pending: unknown[] = [];
      let closing = false;
      let finish!: () => void;
      const released = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const flushed = released.then(async () => {
        await pauseFlush;
        if (failWrite !== undefined && key.includes(failWrite))
          throw new Error("Storage unavailable");
        if (source.closed && pending.length > 0) throw new Error("Stream is closed");
        source.chunks.push(...pending);
        if (closing) source.closed = true;
      });
      options.ops.push(flushed);
      const writable = new WritableStream({
        write(value) {
          pending.push(structuredClone(value));
        },
        close() {
          closing = true;
        },
      });
      const getWriter = writable.getWriter.bind(writable);
      writable.getWriter = () => {
        const writer = getWriter();
        const release = writer.releaseLock.bind(writer);
        writer.releaseLock = () => {
          release();
          finish();
        };
        return writer;
      };
      return writable;
    },
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session directory", () => {
  it("resolves the canonical descriptor after duplicate holder bootstrap", async () => {
    const resources = createSessionResources("winner", "first");
    await initializeSessionResources(resources);
    await publishSessionDescriptor(resources.holderRunId, resources);
    await publishSessionDescriptor("loser", resources);

    expect(await sessionDirectory.resolveHolder("loser")).toEqual(resources);
    expect(await sessionDirectory.resolveSession(resources.sessionId)).toEqual(resources);
    expect(stored(streamKey("loser", "eve.session.resources")).closed).toBe(true);
    expect(streams.has(streamKey("loser", "eve.session.snapshots"))).toBe(false);
  });

  it("caches only successful immutable descriptors within one storage scope", async () => {
    const resources = createSessionResources("holder", "first");
    await initializeSessionResources(resources);
    await publishSessionDescriptor(resources.holderRunId, resources);
    const descriptor = await sessionDirectory.resolveHolder("holder");
    const firstReads = reads;
    expect(await sessionDirectory.resolveHolder("holder")).toBe(descriptor);
    expect(reads).toBe(firstReads);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.events)).toBe(true);

    runtime.getWorld.mockResolvedValue({});
    expect(await sessionDirectory.resolveHolder("holder")).not.toBe(descriptor);
    expect(reads).toBeGreaterThan(firstReads);
  });

  it("publishes readiness once and rejects a changed resource descriptor on retry", async () => {
    const resources = createSessionResources("holder", "first");
    await initializeSessionResources(resources);
    expect(streams.has(streamKey("holder", "eve.session.resources"))).toBe(false);
    await publishSessionDescriptor("holder", resources);
    await publishSessionDescriptor("holder", resources);
    expect(stored(streamKey("holder", "eve.session.resources")).chunks).toHaveLength(1);
    await expect(
      publishSessionDescriptor("holder", { ...resources, initialEventId: "changed" }),
    ).rejects.toThrow("different contents");
  });
});

describe("session snapshots", () => {
  it("returns an empty initialized snapshot without waiting for a future writer", async () => {
    const { snapshots } = createSessionResources("holder", "first");
    await sessionSnapshots.initialize(snapshots);
    await expect(sessionSnapshots.latest(snapshots)).resolves.toBeUndefined();
    expect(cancellations).toBeGreaterThan(0);
  });

  it("keeps exact records immutable when a later checkpoint becomes latest", async () => {
    const { snapshots } = createSessionResources("holder", "first");
    await sessionSnapshots.initialize(snapshots);
    const initial = { writeId: "first:commit", history: ["one"], state: new Map([["count", 1]]) };
    const first = await sessionSnapshots.append(snapshots, initial);
    const second = await sessionSnapshots.append(snapshots, {
      writeId: "second:commit",
      history: ["one", "two"],
    });

    expect(await sessionSnapshots.read(first)).toEqual(initial);
    expect((await sessionSnapshots.latest(snapshots))?.ref).toEqual(second);
    const length = stored(snapshots.id).chunks.length;
    expect(await sessionSnapshots.append(snapshots, initial)).toEqual(first);
    expect(stored(snapshots.id).chunks).toHaveLength(length);
    expect((await sessionSnapshots.latest(snapshots))?.ref).toEqual(second);
    await expect(
      sessionSnapshots.append(snapshots, { ...initial, history: ["changed"] }),
    ).rejects.toThrow("different state");
  });

  it("finishes an interrupted write at the same address without republishing its head", async () => {
    const { snapshots } = createSessionResources("holder", "first");
    await sessionSnapshots.initialize(snapshots);
    failWrite = ".record.";
    const checkpoint = { writeId: "commit", history: ["accepted"] };
    await expect(sessionSnapshots.append(snapshots, checkpoint)).rejects.toThrow(
      "Storage unavailable",
    );
    const length = stored(snapshots.id).chunks.length;
    failWrite = undefined;
    const ref = await sessionSnapshots.append(snapshots, checkpoint);
    expect(stored(snapshots.id).chunks).toHaveLength(length);
    expect(await sessionSnapshots.latest(snapshots)).toEqual({ ref, checkpoint });
  });

  it("reports an unfinished predecessor instead of restoring an older checkpoint", async () => {
    vi.useFakeTimers();
    const { snapshots } = createSessionResources("holder", "first");
    await sessionSnapshots.initialize(snapshots);
    await sessionSnapshots.append(snapshots, { writeId: "before", history: [] });
    failWrite = ".record.";
    await expect(
      sessionSnapshots.append(snapshots, { writeId: "unfinished", history: ["accepted"] }),
    ).rejects.toThrow("Storage unavailable");
    const assertion = expect(sessionSnapshots.latest(snapshots)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});

describe("session event writes", () => {
  it("waits for released writer operations to persist without closing the shared stream", async () => {
    const { events } = createSessionResources("holder", "first");
    let flush!: () => void;
    pauseFlush = new Promise<void>((resolve) => {
      flush = resolve;
    });
    const event = stampMessageStreamEvent(createSessionStartedEvent());
    let completed = false;
    const pending = sessionEvents.append(events, [event]).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(stored(events.id).chunks).toHaveLength(0);
    flush();
    await pending;
    expect(stored(events.id).closed).toBe(false);
    const reader = sessionEvents.read(events).getReader();
    expect((await reader.read()).value).toEqual(event);
    await reader.cancel();
    reader.releaseLock();
    expect(await sessionEvents.tailIndex(events)).toBe(0);
  });

  it("drains durable writes before preserving a callback failure", async () => {
    const { events } = createSessionResources("holder", "first");
    let flush!: () => void;
    pauseFlush = new Promise<void>((resolve) => {
      flush = resolve;
    });
    const failure = new Error("Callback failed");
    const pending = sessionEvents.withWriter(events, async (writable) => {
      const writer = writable.getWriter();
      await writer.write(new Uint8Array([1]));
      writer.releaseLock();
      throw failure;
    });
    const assertion = expect(pending).rejects.toBe(failure);
    expect(stored(events.id).chunks).toHaveLength(0);
    flush();
    await assertion;
    expect(stored(events.id).chunks).toEqual([new Uint8Array([1])]);
  });

  it("reports both callback and durability failures without masking either", async () => {
    const { events } = createSessionResources("holder", "first");
    failWrite = "holder";
    const failure = new Error("Callback failed");
    const pending = sessionEvents.withWriter(events, async (writable) => {
      const writer = writable.getWriter();
      await writer.write(new Uint8Array([1]));
      writer.releaseLock();
      throw failure;
    });
    await expect(pending).rejects.toMatchObject({
      errors: [failure, expect.objectContaining({ message: "Storage unavailable" })],
    });
  });

  it("fails explicitly when the installed SDK lacks the new public API", async () => {
    runtime.getRun.mockReturnValue({});
    await expect(getRunWritable("holder", {})).rejects.toThrow("Run#getWritable");
  });
});
