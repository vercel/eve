import { describe, expect, it, vi } from "vitest";

import type { InstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import {
  constructInstrumentation,
  createInstrumentationRuntime,
} from "#harness/instrumentation/runtime.js";

function runtime(publish = vi.fn()): InstrumentationRuntime {
  const hooks = { capturesContent: true, publish };
  return createInstrumentationRuntime({
    createHooks: () => hooks,
    forceFlush: async () => undefined,
    otelSettings: {
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
    },
    resolveDecision: () => ({ action: "drop", recordInputs: false, recordOutputs: false }),
    runInContext: (_operation, execute) => execute(),
    runWithTracingSuppressed: (execute) => execute(),
    shutdown: async () => undefined,
  });
}

describe("constructInstrumentation", () => {
  it("applies directional content controls before publishing", async () => {
    const publish = vi.fn();
    const constructed = constructInstrumentation(runtime(publish), {
      action: "record",
      recordInputs: false,
      recordOutputs: true,
    });

    await constructed.harness!.hooks.publish({
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
    await constructed.harness!.hooks.publish({
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
    expect(constructed.harness?.otelSettings).toMatchObject({
      recordInputs: false,
      recordOutputs: true,
    });
  });

  it("suppresses OTel while retaining metadata-only provider events", () => {
    const constructed = constructInstrumentation(runtime(), {
      action: "drop",
      recordInputs: false,
      recordOutputs: false,
    });

    expect(constructed.harness?.hooks.capturesContent).toBe(false);
    expect(constructed.harness?.otelSettings).toBeUndefined();
    expect(constructed.harness?.prepareSessionTrace).toBeUndefined();
    expect(constructed.harness?.prepareTurnTrace).toBeUndefined();
  });
});
