import { describe, expect, it, vi } from "vitest";

import type { InstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { bindInstrumentationRuntime } from "#harness/instrumentation/runtime.js";

function runtime(publish = vi.fn()): InstrumentationRuntime {
  return {
    forceFlush: async () => undefined,
    hooks: { capturesContent: true, publish },
    otelSettings: {
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
    },
    resolveControls: () => ({ action: "drop", recordInputs: false, recordOutputs: false }),
    runInContext: (_operation, execute) => execute(),
    runWithTracingSuppressed: (execute) => execute(),
    shutdown: async () => undefined,
  };
}

describe("bindInstrumentationRuntime", () => {
  it("applies directional content controls before publishing", async () => {
    const publish = vi.fn();
    const bound = bindInstrumentationRuntime(runtime(publish), {
      action: "record",
      recordInputs: false,
      recordOutputs: true,
    });

    await bound.hooks.publish({
      idempotencyKey: "model-1",
      input: { instructions: "secret", messages: [] },
      model: { modelId: "test", provider: "test" },
      scope: {
        attemptId: "attempt-1",
        attemptIndex: 0,
        sessionId: "session-1",
        stepIndex: 0,
        turnId: "turn-1",
      },
      type: "model.call.started",
    });
    await bound.hooks.publish({
      content: [{ text: "visible", type: "text" }],
      finishReason: "stop",
      idempotencyKey: "model-1",
      scope: {
        attemptId: "attempt-1",
        attemptIndex: 0,
        sessionId: "session-1",
        stepIndex: 0,
        turnId: "turn-1",
      },
      type: "model.call.completed",
      usage: {},
    });

    expect(publish.mock.calls[0]?.[0]).toHaveProperty("input", undefined);
    expect(publish.mock.calls[1]?.[0]).toHaveProperty("content");
    expect(bound.otelSettings).toMatchObject({
      enabled: true,
      recordInputs: false,
      recordOutputs: true,
    });
  });

  it("suppresses OTel while retaining metadata-only provider events", () => {
    const bound = bindInstrumentationRuntime(runtime(), {
      action: "drop",
      recordInputs: false,
      recordOutputs: false,
    });

    expect(bound.hooks.capturesContent).toBe(false);
    expect(bound.otelSettings).toMatchObject({
      enabled: false,
      recordInputs: false,
      recordOutputs: false,
    });
    expect(bound.prepareSessionTrace).toBeUndefined();
    expect(bound.prepareTurnTrace).toBeUndefined();
  });
});
