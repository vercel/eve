import { describe, expect, it, vi } from "vitest";
import { createSessionEventWriter } from "#execution/session/event-writer.js";

describe("session event writer", () => {
  it("enqueues before storage opens and drains eagerly in event order", async () => {
    const opened = Promise.withResolvers<void>();
    const persisted: number[] = [];
    const sink = createSessionEventWriter(async (consume) => {
      await opened.promise;
      await consume(
        new WritableStream({
          write(bytes) {
            persisted.push(bytes[0]!);
          },
        }),
      );
    });
    const writer = sink.writable.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    expect(persisted).toEqual([]);
    opened.resolve();
    await vi.waitFor(() => expect(persisted).toEqual([1, 2]));
    await writer.write(new Uint8Array([3]));
    writer.releaseLock();
    await sink.finish();
    expect(persisted).toEqual([1, 2, 3]);
  });

  it("does not block enqueueing on a slow storage write but finish waits for durability", async () => {
    const written = Promise.withResolvers<void>();
    const flushed = Promise.withResolvers<void>();
    const sink = createSessionEventWriter(async (consume) => {
      await consume(new WritableStream({ write: () => written.promise }));
      await flushed.promise;
    });
    const writer = sink.writable.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    writer.releaseLock();
    const finished = vi.fn();
    const pending = sink.finish().then(finished);
    written.resolve();
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    flushed.resolve();
    await pending;
    expect(finished).toHaveBeenCalledOnce();
  });

  it("signals storage failure while producers are active", async () => {
    const failed = Promise.withResolvers<void>();
    const error = new Error("Storage unavailable");
    const sink = createSessionEventWriter(async (consume) => {
      await consume(new WritableStream({ write: () => failed.promise }));
    });
    const writer = sink.writable.getWriter();
    await writer.write(new Uint8Array([1]));
    failed.reject(error);
    await vi.waitFor(() => expect(sink.failureSignal.aborted).toBe(true));
    expect(sink.failureSignal.reason).toBe(error);
    await expect(writer.write(new Uint8Array([2]))).rejects.toBe(error);
    writer.releaseLock();
    await expect(sink.finish()).rejects.toBe(error);
  });

  it("rejects overflow instead of waiting for storage or growing without bound", async () => {
    const opening = Promise.withResolvers<void>();
    const sink = createSessionEventWriter(async () => {
      await opening.promise;
    });
    const writer = sink.writable.getWriter();
    await expect(writer.write(new Uint8Array(16 * 1024 * 1024 + 1))).rejects.toThrow("capacity");
    writer.releaseLock();
    opening.resolve();
    await expect(sink.finish()).rejects.toThrow("capacity");
  });

  it("does not open storage for a step that emits nothing", async () => {
    const persist = vi.fn();
    const sink = createSessionEventWriter(persist);
    await sink.finish();
    expect(persist).not.toHaveBeenCalled();
  });
});
