import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import { buildChannelInstrumentationProjection } from "#channel/instrumentation.js";

describe("channel instrumentation", () => {
  it("uses the registered path-derived channel name as the instrumentation kind", () => {
    const adapter: ChannelAdapter = {
      kind: "slack",
      state: {},
    };

    expect(buildChannelInstrumentationProjection({ adapter, channelName: "support" })).toEqual({
      channelType: "slack",
      kind: "channel:support",
      metadata: { audience: "unknown" },
    });
  });

  it.each(["public", "private", "unknown"] as const)("preserves the %s audience", (audience) => {
    const adapter: ChannelAdapter = {
      instrumentation: { metadata: () => ({ audience }) },
      kind: "slack",
      state: {},
    };

    expect(buildChannelInstrumentationProjection({ adapter }).metadata).toEqual({ audience });
  });

  it("normalizes an invalid audience to unknown without dropping other metadata", () => {
    const adapter: ChannelAdapter = {
      instrumentation: {
        metadata: () => ({ audience: "everyone", threadId: "thread-1" }) as never,
      },
      kind: "slack",
      state: {},
    };

    expect(buildChannelInstrumentationProjection({ adapter }).metadata).toEqual({
      audience: "unknown",
      threadId: "thread-1",
    });
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
      metadata: { audience: "unknown" },
    });
    await Promise.resolve();

    expect(observed).toBe(true);
  });
});
