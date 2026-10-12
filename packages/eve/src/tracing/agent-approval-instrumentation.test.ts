import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import type { JsonValue } from "#shared/json.js";
import type {
  InstrumentationAttemptScope,
  InstrumentationHandlerContext,
  InstrumentationInteractionSettledEvent,
} from "#instrumentation/lifecycle.js";
import { createAgentApprovalInstrumentation } from "#tracing/agent-approval-instrumentation.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";

const scope: InstrumentationAttemptScope = {
  attemptId: "session-1:turn_1:0:0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn_1",
};

describe("approval spans", () => {
  it.each([
    ["accepted", "approved"],
    ["declined", "denied"],
    ["withdrawn", "ignored"],
    ["interrupted", "cancelled"],
    ["invalid", "invalid"],
  ] as const)("record a %s approval as trace schema 4's %s", async (outcome, recorded) => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const approvals = createAgentApprovalInstrumentation({
      actionContextFor: async () => ({
        context: undefined as never,
        spanContext: { spanId: "1".repeat(16), traceFlags: 1, traceId: "2".repeat(32) },
      }),
      frameworkVersion: "test",
      idGenerator: new AgentSpanIdGenerator(),
      tracer: provider.getTracer("test"),
    });
    let staged: JsonValue | undefined;
    const ctx: InstrumentationHandlerContext = {
      state: { get: () => staged, set: (value) => (staged = value) },
    };
    await approvals["interaction.opened"]!(
      {
        call: { callId: "call-1", name: "deploy" },
        idempotencyKey: "input:session-1:turn_1:interaction-1",
        kind: "approval",
        interactionId: "interaction-1",
        scope,
        type: "interaction.opened",
      },
      ctx,
    );
    const resolved: InstrumentationInteractionSettledEvent = {
      idempotencyKey: "input:session-1:turn_1:interaction-1",
      kind: "approval",
      outcome,
      interactionId: "interaction-1",
      scope,
      type: "interaction.settled",
    };
    await approvals["interaction.settled"]!(resolved, ctx);

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toMatchObject({
      "agent.approval.kind": "tool-approval",
      "agent.approval.outcome": recorded,
    });
  });
});
