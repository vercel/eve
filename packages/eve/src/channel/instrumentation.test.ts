import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";
import { resolveAudience } from "#channel/audience.js";
import type { AudienceInput } from "#shared/conversation-context.js";

const audienceInput: AudienceInput<Record<string, unknown>> = {
  auth: null,
  channel: { kind: "channel:support", name: "support" },
  environment: "production",
  mode: "conversation",
  state: {},
};

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

  it("ignores an asynchronous audience classifier", () => {
    const adapter: ChannelAdapter = {
      instrumentation: { audience: () => Promise.resolve("public") as never },
      kind: "slack",
      state: {},
    };

    expect(resolveAudience(adapter, audienceInput)).toBe("unknown");
  });

  it("consumes a rejected classifier promise before failing closed", async () => {
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
  });
});
