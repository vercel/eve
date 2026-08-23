import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey, InstrumentationControlsKey } from "#context/keys.js";
import { prepareDeliveryInstrumentation } from "#execution/instrumentation-controls.js";
import { consumeDeliveryInstrumentationControls } from "#execution/instrumentation-controls.js";
import { setChannelContext } from "#execution/channel-context.js";
import type { InstrumentationRuntime } from "#harness/instrumentation/runtime.js";

function runtime(): InstrumentationRuntime {
  return {
    forceFlush: async () => undefined,
    hooks: { capturesContent: true, publish: async () => undefined },
    otelSettings: {
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
    },
    resolveControls: () => ({ action: "record", recordInputs: true, recordOutputs: true }),
    runInContext: (_operation, execute) => execute(),
    runWithTracingSuppressed: (execute) => execute(),
    shutdown: async () => undefined,
  };
}

describe("prepareDeliveryInstrumentation", () => {
  it("removes audience from the channel projection before the harness", () => {
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:slack",
      metadata: { audience: "private", threadTs: "1234.5678" },
    });

    const prepared = prepareDeliveryInstrumentation({
      adapter: { kind: "slack" },
      ctx,
      delivery: { kind: "deliver" },
      instrumentation: runtime(),
      rootSessionId: "session-1",
      sessionId: "session-1",
    });

    expect(prepared.channel).toEqual({
      kind: "channel:slack",
      metadata: { threadTs: "1234.5678" },
    });
  });

  it("allows a local subagent decision to tighten but not loosen inherited controls", () => {
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, { kind: "subagent", metadata: { audience: "public" } });
    ctx.set(InstrumentationControlsKey, {
      action: "record",
      recordInputs: false,
      recordOutputs: true,
    });

    prepareDeliveryInstrumentation({
      adapter: { kind: "subagent" },
      ctx,
      delivery: { kind: "deliver" },
      instrumentation: runtime(),
      rootSessionId: "session-1",
      sessionId: "session-1",
    });

    expect(ctx.get(InstrumentationControlsKey)).toEqual({
      action: "record",
      recordInputs: false,
      recordOutputs: true,
    });
  });

  it("consumes controls ferried to a persistent local child", () => {
    const ctx = new ContextContainer();
    const delivery = consumeDeliveryInstrumentationControls(ctx, {
      kind: "deliver",
      payloads: [
        {
          instrumentationControls: {
            action: "drop",
            recordInputs: false,
            recordOutputs: false,
          },
          message: "private",
        },
      ],
    });

    expect(ctx.get(InstrumentationControlsKey)).toEqual({
      action: "drop",
      recordInputs: false,
      recordOutputs: false,
    });
    expect(delivery.payloads).toEqual([{ message: "private" }]);
  });

  it("preserves inherited audience metadata when subagent state is refreshed", () => {
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      kind: "subagent",
      metadata: { audience: "public", parent: "session-1" },
    });

    setChannelContext(ctx, { kind: "subagent", state: { updated: true } });

    expect(ctx.get(ChannelInstrumentationKey)?.metadata).toEqual({
      audience: "public",
      parent: "session-1",
    });
  });
});
