import { describe, expect, it } from "vitest";

import { withInstrumentationDecision } from "#instrumentation/content.js";
import type {
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
} from "#instrumentation/lifecycle.js";

const scope = {
  attemptId: "attempt-1",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

describe("withInstrumentationDecision", () => {
  it("treats input requests as outputs and user responses as inputs", () => {
    const requested = withInstrumentationDecision(
      {
        action: { callId: "call-1", name: "approve" },
        idempotencyKey: "request-1",
        kind: "tool-approval",
        request: { prompt: "Approve?" },
        requestId: "request-1",
        scope,
        type: "input.requested",
      } satisfies InstrumentationInputRequestedEvent,
      { action: "record", recordInputs: true, recordOutputs: false },
    );
    const resolved = withInstrumentationDecision(
      {
        error: new Error("failed"),
        idempotencyKey: "request-1",
        kind: "tool-approval",
        outcome: "approved",
        requestId: "request-1",
        response: { text: "yes" },
        scope,
        type: "input.resolved",
      } satisfies InstrumentationInputResolvedEvent,
      { action: "record", recordInputs: true, recordOutputs: false },
    );

    expect(requested).toEqual(expect.objectContaining({ request: undefined }));
    expect(resolved).toEqual(
      expect.objectContaining({ error: undefined, response: { text: "yes" } }),
    );
  });

  it("keeps output-side requests and errors while removing user responses", () => {
    const requested = {
      action: { callId: "call-1", name: "approve" },
      idempotencyKey: "request-1",
      kind: "tool-approval",
      request: { prompt: "Approve?" },
      requestId: "request-1",
      scope,
      type: "input.requested",
    } satisfies InstrumentationInputRequestedEvent;
    const error = new Error("failed");
    const resolved = {
      error,
      idempotencyKey: "request-1",
      kind: "tool-approval",
      outcome: "failed",
      requestId: "request-1",
      response: { text: "no" },
      scope,
      type: "input.resolved",
    } satisfies InstrumentationInputResolvedEvent;
    const decision = { action: "record", recordInputs: false, recordOutputs: true } as const;

    expect(withInstrumentationDecision(requested, decision)).toBe(requested);
    expect(withInstrumentationDecision(resolved, decision)).toEqual(
      expect.objectContaining({ error, response: undefined }),
    );
  });

  it("reduces provider metadata to structural output when outputs are disabled", () => {
    const projected = withInstrumentationDecision(
      {
        idempotencyKey: "attempt-1",
        providerMetadata: {
          gateway: { cost: "0.01", generationId: "gen-1", secret: "hidden" },
          secret: "hidden",
        },
        scope,
        type: "step.attempt.metadata",
      },
      { action: "record", recordInputs: true, recordOutputs: false },
    );

    expect(projected).toEqual(
      expect.objectContaining({
        providerMetadata: { gateway: { cost: "0.01", generationId: "gen-1" } },
      }),
    );
  });
});
