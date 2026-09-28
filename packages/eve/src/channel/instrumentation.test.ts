import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import { resolveAudience } from "#channel/audience.js";
import type { AudienceContext } from "#shared/conversation-context.js";
import { captureLogRecords } from "#internal/testing/log-records.js";

const audienceInput: AudienceContext<Record<string, unknown>> = {
  auth: null,
  caller: { type: "anonymous" },
  channel: { kind: "channel:support", name: "support" },
  environment: "production",
  state: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel instrumentation", () => {
  it("uses the registered path-derived channel name as the instrumentation kind", () => {
    const adapter: ChannelAdapter = {
      kind: "slack",
      state: {},
    };

    expect(buildChannelInstrumentationProjection({ adapter, channelName: "support" })).toEqual({
      channelType: "slack",
      kind: "channel:support",
      metadata: {},
    });
  });

  it.each(["public", "private", "unknown"] as const)("preserves the %s audience", (audience) => {
    const adapter: ChannelAdapter = {
      instrumentation: { audience: () => audience },
      kind: "slack",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe(audience);
  });

  it("normalizes an invalid audience to unknown", () => {
    const adapter: ChannelAdapter = {
      instrumentation: {
        audience: () => "everyone" as never,
      },
      kind: "slack",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe("unknown");
  });

  it("drops the former audience key from metadata", () => {
    const adapter: ChannelAdapter = {
      instrumentation: { metadata: () => ({ audience: "public", threadId: "thread-1" }) },
      kind: "slack",
      state: {},
    };

    expect(buildChannelInstrumentationProjection({ adapter }).metadata).toEqual({
      threadId: "thread-1",
    });
  });

  it("uses deprecated metadata audience as the v19 compatibility fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter: ChannelAdapter = {
      instrumentation: { metadata: () => ({ audience: "public", threadId: "thread-1" }) },
      kind: "legacy-kind",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe("public");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "channel legacy-kind uses deprecated metadata audience; move it to the audience() hook",
    );
    expect(buildChannelInstrumentationProjection({ adapter }).metadata).toEqual({
      threadId: "thread-1",
    });
  });

  it("prefers the audience hook over deprecated metadata audience", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter: ChannelAdapter = {
      instrumentation: {
        audience: () => "private",
        metadata: () => ({ audience: "public" }),
      },
      kind: "legacy-hook-wins",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe("private");
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores an asynchronous audience classifier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter: ChannelAdapter = {
      instrumentation: { audience: () => Promise.resolve("public") as never },
      kind: "failing-classifier",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe("unknown");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "ignoring channel audience classifier because it returned a Promise",
    );
  });

  it("consumes a rejected classifier promise before failing closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandledRejection = vi.fn();
    process.once("unhandledRejection", unhandledRejection);
    const adapter: ChannelAdapter = {
      instrumentation: {
        audience: () => Promise.reject(new Error("classifier failed")) as never,
      },
      kind: "slack",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe("unknown");
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandledRejection).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandledRejection);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "ignoring channel audience classifier because it returned a Promise",
    );
  });

  it("does not log authored classifier failures verbatim", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter: ChannelAdapter = {
      instrumentation: {
        audience() {
          throw new Error("secret-classifier-failure");
        },
      },
      kind: "slack",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe("unknown");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "ignoring channel audience classifier after failure",
    );
  });

  it("observes rejected thenables before ignoring channel metadata", async () => {
    const logs = captureLogRecords();
    let observed = false;
    const promise = Promise.reject(new Error("metadata failed"));
    const originalCatch = promise.catch.bind(promise);
    promise.catch = ((onRejected) => {
      observed = true;
      return originalCatch(onRejected);
    }) as typeof promise.catch;
    const adapter: ChannelAdapter = {
      instrumentation: {
        metadata() {
          return promise as never;
        },
      },
      kind: "slack",
      state: {},
    };

    expect(buildChannelInstrumentationProjection({ adapter, channelName: "support" })).toEqual({
      channelType: "slack",
      kind: "channel:support",
      metadata: {},
    });
    await Promise.resolve();

    expect(observed).toBe(true);
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "ignoring instrumentation projection because it returned a Promise",
      }),
    );
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "ignored instrumentation projection Promise rejected",
      }),
    );
  });
});
