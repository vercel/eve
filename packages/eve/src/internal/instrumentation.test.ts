import { describe, expect, it, vi } from "vitest";

import {
  isInstrumentationChannelKind,
  normalizeInstrumentationChannelKind,
  resolveInstrumentationProjection,
} from "#internal/instrumentation.js";
import type { Logger } from "#internal/logging.js";

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn };
}

describe("isInstrumentationChannelKind", () => {
  it("accepts framework kinds and path-derived channel kinds", () => {
    expect(isInstrumentationChannelKind("http")).toBe(true);
    expect(isInstrumentationChannelKind("schedule")).toBe(true);
    expect(isInstrumentationChannelKind("subagent")).toBe(true);
    expect(isInstrumentationChannelKind("channel:support")).toBe(true);
  });

  it("rejects the unknown fallback and unregistered kinds", () => {
    expect(isInstrumentationChannelKind("unknown")).toBe(false);
    expect(isInstrumentationChannelKind("slack")).toBe(false);
    expect(isInstrumentationChannelKind("")).toBe(false);
  });
});

describe("normalizeInstrumentationChannelKind", () => {
  it("passes through valid kinds", () => {
    expect(normalizeInstrumentationChannelKind("http")).toBe("http");
    expect(normalizeInstrumentationChannelKind("channel:support")).toBe("channel:support");
  });

  it("falls back to unknown for missing or unrecognized kinds", () => {
    expect(normalizeInstrumentationChannelKind(undefined)).toBe("unknown");
    expect(normalizeInstrumentationChannelKind("slack")).toBe("unknown");
  });
});

describe("resolveInstrumentationProjection", () => {
  it("returns the record a projector produced", () => {
    const log = fakeLogger();
    expect(
      resolveInstrumentationProjection({ invoke: () => ({ a: "1" }), log, source: "test" }),
    ).toEqual({ a: "1" });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and returns undefined when the projector throws", () => {
    const log = fakeLogger();
    expect(
      resolveInstrumentationProjection({
        invoke: () => {
          throw new Error("boom");
        },
        log,
        source: "test",
      }),
    ).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("warns, observes the rejection, and returns undefined for a thenable", async () => {
    const log = fakeLogger();
    const promise = Promise.reject(new Error("async projection"));
    const observed = vi.fn();
    const originalCatch = promise.catch.bind(promise);
    promise.catch = ((onRejected) => {
      observed();
      return originalCatch(onRejected);
    }) as typeof promise.catch;

    expect(
      resolveInstrumentationProjection({ invoke: () => promise, log, source: "test" }),
    ).toBeUndefined();
    expect(observed).toHaveBeenCalled();
    await Promise.resolve();
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns undefined without warning for an undefined result", () => {
    const log = fakeLogger();

    expect(
      resolveInstrumentationProjection({ invoke: () => undefined, log, source: "test" }),
    ).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and returns undefined for a non-record result", () => {
    const log = fakeLogger();
    expect(
      resolveInstrumentationProjection({ invoke: () => "nope", log, source: "test" }),
    ).toBeUndefined();
    expect(
      resolveInstrumentationProjection({ invoke: () => [1, 2, 3], log, source: "test" }),
    ).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("warns and returns undefined for a record outside the eve JSON contract", () => {
    const log = fakeLogger();

    expect(
      resolveInstrumentationProjection({
        invoke: () => ({ tags: new Map([["team", "platform"]]) }),
        log,
        source: "test",
      }),
    ).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
