import { instrumentationScope } from "#instrumentation/scope.js";
import { describe, expect, it } from "vitest";

import { instrumentationEventForTraceDecision } from "#instrumentation/content-policy.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";

const event: InstrumentationEvent = {
  idempotencyKey: "model:session-1:turn-1:0:0:0",
  input: { instructions: "private prompt", messages: [] },
  model: { modelId: "test", provider: "test" },
  scope: instrumentationScope(
    {
      runId: "session-1:turn-1:0:0",
      attempt: 0,
      sessionId: "session-1",
      turnId: "turn-1",
    },
    0,
  ),
  type: "model.call.started",
};

const contentContext = (
  audience: "public" | "private" | "unknown",
  environment: "development" | "preview" | "production" = "production",
) => ({ audience, environment });

describe("instrumentationEventForTraceDecision", () => {
  it("applies directional OTel content decisions", () => {
    expect(
      instrumentationEventForTraceDecision(
        event,
        { action: "record", recordInputs: false, recordOutputs: true },
        contentContext("public"),
      ),
    ).toMatchObject({ input: undefined });
  });

  it("classifies approval requests as outputs and responses as inputs", () => {
    const decision = { action: "record", recordInputs: false, recordOutputs: true } as const;
    expect(
      instrumentationEventForTraceDecision(
        {
          call: { callId: "call-1", name: "weather" },
          idempotencyKey: "input-1",
          kind: "approval",
          request: { prompt: "Approve weather?" },
          interactionId: "request-1",
          scope: event.scope,
          type: "interaction.opened",
        },
        decision,
        contentContext("public"),
      ),
    ).toMatchObject({ request: { prompt: "Approve weather?" } });
    expect(
      instrumentationEventForTraceDecision(
        {
          idempotencyKey: "input-1",
          kind: "approval",
          outcome: "accepted",
          interactionId: "request-1",
          answer: { optionId: "approve" },
          scope: event.scope,
          type: "interaction.settled",
        },
        decision,
        contentContext("public"),
      ),
    ).toMatchObject({ answer: undefined });
  });

  it("applies the OTel audience ceiling", () => {
    expect(
      instrumentationEventForTraceDecision(
        event,
        { action: "record", recordInputs: true, recordOutputs: true },
        contentContext("private"),
      ),
    ).toMatchObject({ input: undefined });
  });

  it("uses an already-intersected forwarded decision without reapplying origin audience", () => {
    expect(
      instrumentationEventForTraceDecision(
        event,
        { action: "record", recordInputs: true, recordOutputs: false },
        contentContext("private"),
        { applyAudienceCeiling: false },
      ),
    ).toMatchObject({ input: { instructions: "private prompt" } });
  });

  it("removes content from dropped OTel traces", () => {
    expect(
      instrumentationEventForTraceDecision(event, { action: "drop" }, contentContext("public")),
    ).toMatchObject({ input: undefined });
  });
});
