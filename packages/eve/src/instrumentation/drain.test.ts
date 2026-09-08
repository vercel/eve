import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstrumentationDrain,
  INSTRUMENTATION_DRAIN_TIMEOUT_MS,
} from "#instrumentation/drain.js";

afterEach(() => vi.useRealTimers());

describe("instrumentation drains", () => {
  it("bounds a stuck drain and coalesces subsequent requests", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const drain = createInstrumentationDrain("test", operation);
    const first = drain();
    const concurrent = drain();
    expect(concurrent).toBe(first);
    await vi.advanceTimersByTimeAsync(INSTRUMENTATION_DRAIN_TIMEOUT_MS);
    await Promise.all([first, concurrent]);
    const retry = drain();
    await vi.advanceTimersByTimeAsync(INSTRUMENTATION_DRAIN_TIMEOUT_MS);
    await retry;
    for (let index = 0; index < 1000; index++) expect(drain()).toBe(first);
    expect(vi.getTimerCount()).toBe(0);
    expect(operation).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    const next = drain();
    await vi.advanceTimersByTimeAsync(INSTRUMENTATION_DRAIN_TIMEOUT_MS);
    finish();
    await next;
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("isolates synchronous and asynchronous failures", async () => {
    await expect(
      createInstrumentationDrain("sync", () => {
        throw new Error("private");
      })(),
    ).resolves.toBeUndefined();
    await expect(
      createInstrumentationDrain("async", () => Promise.reject(new Error("private")))(),
    ).resolves.toBeUndefined();
  });
});
