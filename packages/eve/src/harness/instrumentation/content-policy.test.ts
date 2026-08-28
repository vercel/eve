import { describe, expect, it } from "vitest";

import { instrumentationEventForTraceDecision } from "#harness/instrumentation/content-policy.js";
import type { InstrumentationEvent } from "#harness/instrumentation/lifecycle.js";

const event: InstrumentationEvent = {
  idempotencyKey: "model:session-1:turn-1:0:0:0",
  input: { instructions: "private prompt", messages: [] },
  model: { modelId: "test", provider: "test" },
  scope: {
    attemptId: "session-1:turn-1:0:0",
    attemptIndex: 0,
    sessionId: "session-1",
    stepIndex: 0,
    turnId: "turn-1",
  },
  type: "model.call.started",
};

describe("instrumentationEventForTraceDecision", () => {
  it("applies directional OTel content decisions", () => {
    expect(
      instrumentationEventForTraceDecision(
        event,
        { action: "record", recordInputs: false, recordOutputs: true },
        "public",
      ),
    ).toMatchObject({ input: undefined });
  });

  it("classifies approval requests as outputs and responses as inputs", () => {
    const decision = { action: "record", recordInputs: false, recordOutputs: true } as const;
    expect(
      instrumentationEventForTraceDecision(
        {
          action: { callId: "call-1", name: "weather" },
          idempotencyKey: "input-1",
          kind: "tool-approval",
          request: { prompt: "Approve weather?" },
          requestId: "request-1",
          scope: event.scope,
          type: "input.requested",
        },
        decision,
        "public",
      ),
    ).toMatchObject({ request: { prompt: "Approve weather?" } });
    expect(
      instrumentationEventForTraceDecision(
        {
          idempotencyKey: "input-1",
          kind: "tool-approval",
          outcome: "approved",
          requestId: "request-1",
          response: { optionId: "approve" },
          scope: event.scope,
          type: "input.resolved",
        },
        decision,
        "public",
      ),
    ).toMatchObject({ response: undefined });
  });

  it("applies the OTel audience ceiling", () => {
    expect(
      instrumentationEventForTraceDecision(
        event,
        { action: "record", recordInputs: true, recordOutputs: true },
        "private",
      ),
    ).toMatchObject({ input: undefined });
  });

  it("removes content from dropped OTel traces", () => {
    expect(instrumentationEventForTraceDecision(event, { action: "drop" }, "public")).toMatchObject(
      { input: undefined },
    );
  });
});
