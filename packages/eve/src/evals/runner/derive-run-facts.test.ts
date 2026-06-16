import { describe, expect, it } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { JsonObject } from "#shared/json.js";
import { createEmptyDerivedFacts, deriveRunFacts } from "#evals/runner/derive-run-facts.js";

function turnStarted(turnId: string, sequence: number): HandleMessageStreamEvent {
  return { type: "turn.started", data: { turnId, sequence } };
}

function actionsRequested(
  actions: readonly { callId: string; toolName: string; input?: JsonObject }[],
): HandleMessageStreamEvent {
  return {
    type: "actions.requested",
    data: {
      actions: actions.map((action) => ({
        callId: action.callId,
        input: action.input ?? {},
        kind: "tool-call" as const,
        toolName: action.toolName,
      })),
      sequence: 1,
      stepIndex: 0,
      turnId: "t1",
    },
  };
}

function actionResult(input: {
  callId: string;
  toolName: string;
  output?: unknown;
  status?: "completed" | "failed";
  isError?: boolean;
}): HandleMessageStreamEvent {
  return {
    type: "action.result",
    data: {
      result: {
        callId: input.callId,
        isError: input.isError,
        kind: "tool-result" as const,
        output: (input.output ?? null) as never,
        toolName: input.toolName,
      },
      sequence: 1,
      stepIndex: 0,
      status: input.status ?? "completed",
      turnId: "t1",
    },
  };
}

function inputRequested(requestIds: readonly string[]): HandleMessageStreamEvent {
  return {
    type: "input.requested",
    data: {
      requests: requestIds.map((requestId) => ({
        action: {
          callId: `${requestId}-call`,
          input: {},
          kind: "tool-call" as const,
          toolName: "bash",
        },
        prompt: "Approve?",
        requestId,
      })),
      sequence: 1,
      stepIndex: 0,
      turnId: "t1",
    },
  };
}

describe("deriveRunFacts", () => {
  it("returns empty facts for no events", () => {
    const facts = deriveRunFacts([]);
    expect(facts).toEqual({ ...createEmptyDerivedFacts(), failureCode: undefined });
  });

  it("pairs tool calls with their results by call id", () => {
    const events: HandleMessageStreamEvent[] = [
      turnStarted("t1", 0),
      actionsRequested([
        { callId: "c1", toolName: "get_weather", input: { city: "Brooklyn" } },
        { callId: "c2", toolName: "bash", input: { command: "pwd" } },
      ]),
      actionResult({ callId: "c1", toolName: "get_weather", output: { tempF: 72 } }),
      actionResult({
        callId: "c2",
        toolName: "bash",
        output: "command denied",
        status: "failed",
      }),
    ];

    const facts = deriveRunFacts(events, { sessionId: "s1" });

    expect(facts.toolCalls).toEqual([
      {
        name: "get_weather",
        input: { city: "Brooklyn" },
        output: { tempF: 72 },
        isError: false,
        turnIndex: 0,
        sessionId: "s1",
      },
      {
        name: "bash",
        input: { command: "pwd" },
        output: "command denied",
        isError: true,
        turnIndex: 0,
        sessionId: "s1",
      },
    ]);
    expect(facts.toolCallCount).toBe(2);
  });

  it("marks tool calls failed when the result carries isError", () => {
    const events: HandleMessageStreamEvent[] = [
      actionsRequested([{ callId: "c1", toolName: "bash" }]),
      actionResult({ callId: "c1", toolName: "bash", isError: true }),
    ];

    const facts = deriveRunFacts(events);
    expect(facts.toolCalls[0]?.isError).toBe(true);
  });

  it("stamps the turn index from turn.started boundaries", () => {
    const events: HandleMessageStreamEvent[] = [
      turnStarted("t1", 0),
      actionsRequested([{ callId: "c1", toolName: "first_tool" }]),
      actionResult({ callId: "c1", toolName: "first_tool" }),
      turnStarted("t2", 1),
      actionsRequested([{ callId: "c2", toolName: "second_tool" }]),
      actionResult({ callId: "c2", toolName: "second_tool" }),
    ];

    const facts = deriveRunFacts(events);
    expect(facts.toolCalls.map((call) => call.turnIndex)).toEqual([0, 1]);
  });

  it("counts message.completed events whose step completed without tool calls", () => {
    const events: HandleMessageStreamEvent[] = [
      {
        type: "message.completed",
        data: { finishReason: "stop", message: "hello", stepIndex: 0, turnId: "t1", sequence: 1 },
      },
      {
        type: "message.completed",
        data: {
          finishReason: "tool-calls",
          message: null,
          stepIndex: 1,
          turnId: "t1",
          sequence: 2,
        },
      },
      {
        type: "message.completed",
        data: { finishReason: "stop", message: "world", stepIndex: 2, turnId: "t1", sequence: 3 },
      },
    ];
    const facts = deriveRunFacts(events);
    expect(facts.messageCount).toBe(2);
  });

  it("counts reasoning.completed events", () => {
    const events: HandleMessageStreamEvent[] = [
      {
        type: "reasoning.completed",
        data: { reasoning: "thinking...", stepIndex: 0, turnId: "t1", sequence: 1 },
      },
      {
        type: "reasoning.completed",
        data: { reasoning: "more thinking...", stepIndex: 1, turnId: "t1", sequence: 2 },
      },
    ];
    const facts = deriveRunFacts(events);
    expect(facts.reasoningBlockCount).toBe(2);
  });

  it("joins subagent.called with subagent.completed by call id", () => {
    const events: HandleMessageStreamEvent[] = [
      turnStarted("t1", 0),
      {
        type: "subagent.called",
        data: {
          callId: "c1",
          childSessionId: "s1",
          sessionId: "s0",
          sequence: 1,
          name: "weather",
          remote: { url: "http://127.0.0.1:4001" },
          toolName: "call_weather",
          turnId: "t1",
          workflowId: "w1",
        },
      },
      {
        type: "subagent.completed",
        data: { callId: "c1", output: "Sunny, 72F", subagentName: "weather" },
      },
    ];

    const facts = deriveRunFacts(events, { sessionId: "s0" });
    expect(facts.subagentCalls).toEqual([
      {
        name: "weather",
        remoteUrl: "http://127.0.0.1:4001",
        output: "Sunny, 72F",
        isError: false,
        turnIndex: 0,
        sessionId: "s0",
      },
    ]);
    expect(facts.subagentCallCount).toBe(1);
  });

  it("extracts inline subagent calls from subagent.started events", () => {
    const events: HandleMessageStreamEvent[] = [
      {
        type: "subagent.started",
        data: { callId: "c1", subagentName: "inline-agent" },
      },
    ];
    const facts = deriveRunFacts(events);
    expect(facts.subagentCalls.map((call) => call.name)).toEqual(["inline-agent"]);
  });

  it("records every subagent invocation separately", () => {
    const events: HandleMessageStreamEvent[] = [
      {
        type: "subagent.started",
        data: { callId: "c1", subagentName: "agent-a" },
      },
      {
        type: "subagent.started",
        data: { callId: "c2", subagentName: "agent-a" },
      },
    ];
    const facts = deriveRunFacts(events);
    expect(facts.subagentCalls.map((call) => call.name)).toEqual(["agent-a", "agent-a"]);
    expect(facts.subagentCallCount).toBe(2);
  });

  it("captures failure code from session.failed event", () => {
    const events: HandleMessageStreamEvent[] = [
      {
        type: "session.failed",
        data: {
          code: "TIMEOUT",
          message: "Run timed out",
          sessionId: "s1",
        },
      },
    ];
    const facts = deriveRunFacts(events);
    expect(facts.failureCode).toBe("TIMEOUT");
  });

  it("collects HITL input requests", () => {
    const events: HandleMessageStreamEvent[] = [turnStarted("t1", 0), inputRequested(["r1", "r2"])];
    const facts = deriveRunFacts(events);
    expect(facts.inputRequests.map((request) => request.requestId)).toEqual(["r1", "r2"]);
  });

  it("marks the run parked when it ends on unanswered input requests", () => {
    const events: HandleMessageStreamEvent[] = [
      turnStarted("t1", 0),
      inputRequested(["r1"]),
      { type: "turn.completed", data: { sequence: 1, turnId: "t1" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as HandleMessageStreamEvent[];

    const facts = deriveRunFacts(events);
    expect(facts.parked).toBe(true);
  });

  it("does not mark the run parked when the turn continued past the input request", () => {
    const events: HandleMessageStreamEvent[] = [
      turnStarted("t1", 0),
      inputRequested(["r1"]),
      {
        type: "message.completed",
        data: { finishReason: "stop", message: "done", stepIndex: 1, turnId: "t1", sequence: 2 },
      },
      { type: "turn.completed", data: { sequence: 3, turnId: "t1" } },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as HandleMessageStreamEvent[];

    const facts = deriveRunFacts(events);
    expect(facts.parked).toBe(false);
  });
});
