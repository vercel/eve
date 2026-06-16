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
      kind: "channel:support",
      metadata: {},
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
      kind: "channel:support",
      metadata: {},
    });
    await Promise.resolve();

    expect(observed).toBe(true);
  });
});
