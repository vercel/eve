import { afterEach, describe, expect, it, vi } from "vitest";

import { isStreamIdleTimeoutError, readNdjsonStream } from "./ndjson.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("readNdjsonStream", () => {
  it("cancels a response that stops delivering bytes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify({ type: "step.started", data: {} })}\n`),
        );
      },
    });
    const iterator = readNdjsonStream(body, { idleTimeoutMs: 25 });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "step.started" },
    });
    const stalledRead = iterator.next();
    const rejected = expect(stalledRead).rejects.toSatisfy(isStreamIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
