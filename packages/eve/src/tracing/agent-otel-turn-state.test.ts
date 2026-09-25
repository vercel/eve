import { describe, expect, it } from "vitest";

import {
  recordTurnUsage,
  rememberTurnInputMessages,
  rememberTurnOutputMessages,
} from "#tracing/agent-otel-turn-state.js";
import { InMemoryAgentTraceStateStore } from "#tracing/agent-trace-state.js";

describe("agent OTel turn state", () => {
  it("keeps the first model input and latest model output across a multi-call turn", async () => {
    const store = new InMemoryAgentTraceStateStore();
    store.setTurn("session-1", "turn-1", {
      context: spanContext(),
      rootSessionId: "session-1",
      sequence: 0,
      startTimeMs: 1,
    });
    const scope = {
      attemptId: "attempt-1",
      attemptIndex: 0,
      functionId: "agent",
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };

    await rememberTurnInputMessages(store, scope, "first input");
    await rememberTurnInputMessages(store, scope, "second input");
    await rememberTurnOutputMessages(store, scope, "first output");
    await rememberTurnOutputMessages(store, scope, "final output");
    await recordTurnUsage(store, scope, { inputTokens: 3, outputTokens: 2 });
    await recordTurnUsage(store, scope, { inputTokens: 4, outputTokens: 5 });

    expect(store.getTurn("session-1", "turn-1")).toMatchObject({
      inputMessagesAttribute: "first input",
      modelUsage: { inputTokens: 7, outputTokens: 7 },
      outputMessagesAttribute: "final output",
    });
  });
});

function spanContext() {
  return {
    spanId: "2222222222222222",
    traceFlags: 1,
    traceId: "11111111111111111111111111111111",
  };
}
