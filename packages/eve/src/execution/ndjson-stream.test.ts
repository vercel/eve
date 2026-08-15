import { describe, expect, it } from "vitest";

import { parseNdjsonStream } from "#execution/ndjson-stream.js";

const encoder = new TextEncoder();

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      values.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return values;
}

describe("parseNdjsonStream", () => {
  it("parses newline-delimited JSON into values", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"i":0}\n{"i":1}\n'));
        controller.enqueue(encoder.encode('{"i":2}\n'));
        controller.close();
      },
    });

    const values = await drain(parseNdjsonStream<{ i: number }>(() => source));

    expect(values).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  it("emits a trailing line that is not newline-terminated at EOF", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"i":0}\n{"i":1}'));
        controller.close();
      },
    });

    const values = await drain(parseNdjsonStream<{ i: number }>(() => source));

    expect(values).toEqual([{ i: 0 }, { i: 1 }]);
  });

  it("reassembles values split across chunk boundaries", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"i":'));
        controller.enqueue(encoder.encode("0}\n"));
        controller.close();
      },
    });

    const values = await drain(parseNdjsonStream<{ i: number }>(() => source));

    expect(values).toEqual([{ i: 0 }]);
  });

  // Regression guard for the parked-session streaming leak: a parked
  // (`session.waiting`) durable run never closes its event stream, so the
  // world-local streamer keeps a filesystem poll alive until its reader is
  // cancelled. Cancelling the parsed stream must forward the cancel to the
  // source — otherwise the poll leaks for the life of the dev server and
  // degrades streaming for every other session.
  it("forwards cancellation to a source that never reaches EOF", async () => {
    let cancelledReason: unknown = Symbol("not-cancelled");

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit one line, then stay open forever (the parked-run shape).
        controller.enqueue(encoder.encode('{"i":0}\n'));
      },
      cancel(reason) {
        cancelledReason = reason;
      },
    });

    const parsed = parseNdjsonStream<{ i: number }>(() => source);
    const reader = parsed.getReader();

    const first = await reader.read();
    expect(first.value).toEqual({ i: 0 });

    await reader.cancel("client-disconnect");

    expect(cancelledReason).toBe("client-disconnect");
  });

  it("surfaces source errors to the consumer", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("source exploded"));
      },
    });

    await expect(drain(parseNdjsonStream(() => source))).rejects.toThrow("source exploded");
  });
});
