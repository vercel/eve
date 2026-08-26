import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey, InstrumentationDecisionKey } from "#context/keys.js";
import { prepareDeliveryInstrumentation } from "#execution/delivery-instrumentation.js";
import { createInstrumentationHooks } from "#harness/instrumentation/lifecycle.js";
import { createInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import type { InstrumentationRuntime } from "#harness/instrumentation/runtime.js";

function runtime(resolveDecision: InstrumentationRuntime["resolveDecision"]) {
  return createInstrumentationRuntime({
    forceFlush: async () => undefined,
    hooks: createInstrumentationHooks([]),
    otelSettings: {
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
    },
    resolveDecision,
    runInContext: (_operation, execute) => execute(),
    runWithTracingSuppressed: (execute) => execute(),
    shutdown: async () => undefined,
  });
}

describe("prepareDeliveryInstrumentation", () => {
  it("resolves audience before constructing harness capabilities", () => {
    const ctx = new ContextContainer();
    ctx.set(ChannelInstrumentationKey, {
      kind: "channel:test",
      metadata: { audience: "public" },
    });
    const resolveDecision = vi.fn(() => ({
      action: "record" as const,
      recordInputs: false,
      recordOutputs: true,
    }));

    const constructed = prepareDeliveryInstrumentation({
      ctx,
      delivery: { kind: "deliver" },
      instrumentation: runtime(resolveDecision),
      rootSessionId: "session-1",
      sessionId: "session-1",
    });

    expect(resolveDecision).toHaveBeenCalledWith(expect.objectContaining({ audience: "public" }));
    expect(ctx.get(InstrumentationDecisionKey)).toEqual({
      action: "record",
      recordInputs: false,
      recordOutputs: true,
    });
    expect(constructed.harness).not.toHaveProperty("resolveDecision");
  });

  it("constructs dropped deliveries without provider hooks", () => {
    const constructed = prepareDeliveryInstrumentation({
      ctx: new ContextContainer(),
      delivery: { kind: "deliver" },
      instrumentation: runtime(vi.fn(() => ({ action: "drop" as const }))),
      rootSessionId: "session-1",
      sessionId: "session-1",
    });

    expect(constructed.harness?.hooks).toBeUndefined();
    expect(constructed.harness?.telemetryIntegrations).toBeUndefined();
  });
});
