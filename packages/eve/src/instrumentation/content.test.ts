import { instrumentationScope } from "#instrumentation/scope.js";
import { describe, expect, it } from "vitest";

import { withInstrumentationDecision } from "#instrumentation/content.js";
import type {
  InstrumentationInteractionOpenedEvent,
  InstrumentationInteractionSettledEvent,
  InstrumentationSessionStartedEvent,
} from "#instrumentation/lifecycle.js";

const scope = instrumentationScope(
  {
    runId: "attempt-1",
    attempt: 0,
    sessionId: "session-1",
    turnId: "turn-1",
  },
  0,
);

describe("withInstrumentationDecision", () => {
  it("treats the session title as input content", () => {
    const event = {
      agentName: "general",
      channelAudience: "public",
      idempotencyKey: "session:session-1",
      rootSessionId: "session-1",
      scheduleId: "daily-report",
      sessionId: "session-1",
      title: "Private title",
      type: "session.started",
    } satisfies InstrumentationSessionStartedEvent;

    expect(
      withInstrumentationDecision(event, {
        action: "record",
        recordInputs: false,
        recordOutputs: true,
      }),
    ).toEqual(expect.objectContaining({ scheduleId: "daily-report", title: undefined }));
  });

  it("treats input requests as outputs and user responses as inputs", () => {
    const requested = withInstrumentationDecision(
      {
        call: { callId: "call-1", name: "approve" },
        idempotencyKey: "request-1",
        kind: "approval",
        request: { prompt: "Approve?" },
        interactionId: "request-1",
        scope,
        type: "interaction.opened",
      } satisfies InstrumentationInteractionOpenedEvent,
      { action: "record", recordInputs: true, recordOutputs: false },
    );
    const resolved = withInstrumentationDecision(
      {
        error: new Error("failed"),
        idempotencyKey: "request-1",
        kind: "approval",
        outcome: "accepted",
        interactionId: "request-1",
        answer: { text: "yes" },
        scope,
        type: "interaction.settled",
      } satisfies InstrumentationInteractionSettledEvent,
      { action: "record", recordInputs: true, recordOutputs: false },
    );

    expect(requested).toEqual(expect.objectContaining({ request: undefined }));
    expect(resolved).toEqual(
      expect.objectContaining({ error: undefined, answer: { text: "yes" } }),
    );
  });

  it("keeps output-side requests and errors while removing user responses", () => {
    const requested = {
      call: { callId: "call-1", name: "approve" },
      idempotencyKey: "request-1",
      kind: "approval",
      request: { prompt: "Approve?" },
      interactionId: "request-1",
      scope,
      type: "interaction.opened",
    } satisfies InstrumentationInteractionOpenedEvent;
    const error = new Error("failed");
    const resolved = {
      error,
      idempotencyKey: "request-1",
      kind: "approval",
      outcome: "failed",
      interactionId: "request-1",
      answer: { text: "no" },
      scope,
      type: "interaction.settled",
    } satisfies InstrumentationInteractionSettledEvent;
    const decision = { action: "record", recordInputs: false, recordOutputs: true } as const;

    expect(withInstrumentationDecision(requested, decision)).toBe(requested);
    expect(withInstrumentationDecision(resolved, decision)).toEqual(
      expect.objectContaining({ error, answer: undefined }),
    );
  });

  it("treats recalled memory records as inputs", () => {
    const completed = {
      outcome: "completed",
      idempotencyKey: "memory-1",
      operationName: "search_memory",
      outputRecords: [{ content: "The user prefers dark mode.", id: "preference" }],
      phase: "turn.started",
      recordCount: 1,
      rootSessionId: "session-1",
      sessionId: "session-1",
      slot: "profile",
      storeId: "memscope1_scope",
      turnId: "turn-1",
      type: "memory.operation.settled",
    } as const;

    expect(
      withInstrumentationDecision(completed, {
        action: "record",
        recordInputs: true,
        recordOutputs: false,
      }),
    ).toBe(completed);
    expect(
      withInstrumentationDecision(completed, {
        action: "record",
        recordInputs: false,
        recordOutputs: true,
      }),
    ).toEqual(expect.objectContaining({ outputRecords: undefined }));
  });

  it("reduces provider metadata to structural output when outputs are disabled", () => {
    const projected = withInstrumentationDecision(
      {
        idempotencyKey: "attempt-1",
        providerMetadata: {
          gateway: {
            cost: "0.01",
            generationId: "gen-1",
            routing: {
              affinity: { outcome: "confirmed", pinnedProvider: "anthropic", secret: "hidden" },
              clientSessionId: "conversation-1",
              secret: "hidden",
            },
            secret: "hidden",
          },
          secret: "hidden",
        },
        scope,
        type: "model.call.settled",
        outcome: "completed",
        finishReason: "stop",
        usage: {},
      },
      { action: "record", recordInputs: true, recordOutputs: false },
    );

    expect(projected).toEqual(
      expect.objectContaining({
        providerMetadata: {
          gateway: {
            cost: "0.01",
            generationId: "gen-1",
            routing: {
              affinity: { outcome: "confirmed", pinnedProvider: "anthropic" },
              clientSessionId: "conversation-1",
            },
          },
        },
      }),
    );
  });
});
