import { describe, expect, it } from "vitest";

import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { JsonObject } from "#shared/json.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createEmptyDerivedFacts,
  deriveRunFacts,
  type DeriveRunFactsOptions,
} from "#evals/runner/derive-run-facts.js";
import type { EveEvalDerivedFacts } from "#evals/types.js";

/** Fixtures are authored without envelopes; stamp them the way the wire would. */
function derive(
  events: readonly UnstampedMessageStreamEvent[],
  options?: DeriveRunFactsOptions,
): EveEvalDerivedFacts {
  return deriveRunFacts(stampTestEvents(events), options);
}

function turnStarted(turnId: string, sequence: number): UnstampedMessageStreamEvent {
  return { type: "turn.started", data: { turnId, sequence } };
}

function actionsRequested(
  actions: readonly { callId: string; toolName: string; input?: JsonObject }[],
): UnstampedMessageStreamEvent {
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
  status?: "completed" | "failed" | "rejected";
  isError?: boolean;
}): UnstampedMessageStreamEvent {
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
      status: input.status ?? (input.isError === true ? "failed" : "completed"),
      turnId: "t1",
    },
  };
}

function taskStarted(callId: string, name: string, taskId: string): UnstampedMessageStreamEvent {
  return { type: "task.started", data: { callId, name, taskId, turnId: "t1" } };
}

function agentStarted(
  callId: string,
  name: string,
  remote?: { readonly url: string },
): UnstampedMessageStreamEvent {
  const data = { callId, name, sessionId: `child-${callId}`, streamPath: `/stream/${callId}` };
  return { type: "agent.started", data: remote === undefined ? data : { ...data, remote } };
}

function inputRequested(requestIds: readonly string[]): UnstampedMessageStreamEvent {
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
        kind: "tool-approval" as const,
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
    const facts = derive([]);
    expect(facts).toEqual({ ...createEmptyDerivedFacts(), failureCode: undefined });
  });

  it("pairs tool calls with their results by call id", () => {
    const events: UnstampedMessageStreamEvent[] = [
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

    const facts = derive(events, { sessionId: "s1" });

    expect(facts.toolCalls).toEqual([
      {
        name: "get_weather",
        input: { city: "Brooklyn" },
        output: { tempF: 72 },
        status: "completed",
        turnIndex: 0,
        sessionId: "s1",
      },
      {
        name: "bash",
        input: { command: "pwd" },
        output: "command denied",
        status: "failed",
        turnIndex: 0,
        sessionId: "s1",
      },
    ]);
    expect(facts.toolCallCount).toBe(2);
  });

  it("preserves framework skill input in the eval tool-call view", () => {
    const facts = derive([
      turnStarted("t1", 0),
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: "skill-1",
              input: { skill: "research" },
              kind: "load-skill",
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "t1",
        },
      },
      actionResult({ callId: "skill-1", toolName: "load_skill", output: "Skill body" }),
    ]);

    expect(facts.toolCalls).toEqual([
      {
        input: { skill: "research" },
        name: "load_skill",
        output: "Skill body",
        sessionId: undefined,
        status: "completed",
        turnIndex: 0,
      },
    ]);
  });

  it("uses the normalized failed lifecycle status for error results", () => {
    const events: UnstampedMessageStreamEvent[] = [
      actionsRequested([{ callId: "c1", toolName: "bash" }]),
      actionResult({ callId: "c1", toolName: "bash", isError: true }),
    ];

    const facts = derive(events);
    expect(facts.toolCalls[0]?.status).toBe("failed");
  });

  it("distinguishes pending, completed, failed, and rejected tool calls", () => {
    const events: UnstampedMessageStreamEvent[] = [
      actionsRequested([
        { callId: "pending", toolName: "pending" },
        { callId: "completed", toolName: "completed" },
        { callId: "failed", toolName: "failed" },
        { callId: "rejected", toolName: "rejected" },
      ]),
      actionResult({ callId: "completed", toolName: "completed" }),
      actionResult({ callId: "failed", toolName: "failed", status: "failed" }),
      actionResult({ callId: "rejected", toolName: "rejected", status: "rejected" }),
    ];

    expect(derive(events).toolCalls.map((call) => call.status)).toEqual([
      "pending",
      "completed",
      "failed",
      "rejected",
    ]);
  });

  it("derives pending tool calls from HITL input requests", () => {
    const facts = derive([turnStarted("t1", 0), inputRequested(["approval"])]);

    expect(facts.toolCalls).toEqual([
      {
        name: "bash",
        input: {},
        output: undefined,
        status: "pending",
        turnIndex: 0,
        sessionId: undefined,
      },
    ]);
  });

  it("pairs HITL tool calls with resumed results by call id", () => {
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      inputRequested(["approval"]),
      turnStarted("t2", 1),
      actionResult({
        callId: "approval-call",
        toolName: "bash",
        output: "approved",
      }),
    ];

    expect(derive(events).toolCalls).toEqual([
      {
        name: "bash",
        input: {},
        output: "approved",
        status: "completed",
        turnIndex: 0,
        sessionId: undefined,
      },
    ]);
  });

  it("derives resolved tool calls from result-only turn events", () => {
    const facts = derive([
      turnStarted("t2", 1),
      actionResult({ callId: "approval-call", toolName: "bash", status: "rejected" }),
    ]);

    expect(facts.toolCalls).toEqual([
      {
        name: "bash",
        input: {},
        output: null,
        status: "rejected",
        turnIndex: 0,
        sessionId: undefined,
      },
    ]);
  });

  it("deduplicates tool calls surfaced by request and HITL events", () => {
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      actionsRequested([{ callId: "approval-call", toolName: "bash" }]),
      inputRequested(["approval"]),
    ];

    expect(derive(events).toolCalls).toHaveLength(1);
  });

  it("stamps the turn index from turn.started boundaries", () => {
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      actionsRequested([{ callId: "c1", toolName: "first_tool" }]),
      actionResult({ callId: "c1", toolName: "first_tool" }),
      turnStarted("t2", 1),
      actionsRequested([{ callId: "c2", toolName: "second_tool" }]),
      actionResult({ callId: "c2", toolName: "second_tool" }),
    ];

    const facts = derive(events);
    expect(facts.toolCalls.map((call) => call.turnIndex)).toEqual([0, 1]);
  });

  it("counts message.completed events whose step completed without tool calls", () => {
    const events: UnstampedMessageStreamEvent[] = [
      {
        type: "message.completed",
        data: { finishReason: "stop", message: "hello", stepIndex: 0, turnId: "t1", sequence: 1 },
      },
      {
        type: "message.completed",
        data: {
          finishReason: "tool-calls",
          message: "Checking.",
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
    const facts = derive(events);
    expect(facts.messageCount).toBe(2);
  });

  it("counts reasoning.completed events", () => {
    const events: UnstampedMessageStreamEvent[] = [
      {
        type: "reasoning.completed",
        data: { reasoning: "thinking...", stepIndex: 0, turnId: "t1", sequence: 1 },
      },
      {
        type: "reasoning.completed",
        data: { reasoning: "more thinking...", stepIndex: 1, turnId: "t1", sequence: 2 },
      },
    ];
    const facts = derive(events);
    expect(facts.reasoningBlockCount).toBe(2);
  });

  it("derives one subagent call per call to an agent task", () => {
    const facts = derive(
      [
        turnStarted("t1", 0),
        taskStarted("c1", "weather", "weather-1"),
        agentStarted("c1", "weather", { url: "http://127.0.0.1:4001" }),
        {
          type: "task.settled",
          data: { callId: "c1", output: "Sunny, 72F", status: "completed", taskId: "weather-1" },
        },
        turnStarted("t2", 1),
        taskStarted("c2", "weather", "weather-1"),
      ],
      { sessionId: "s0" },
    );

    expect(facts.subagentCalls).toEqual([
      {
        callId: "c1",
        childSessionId: "child-c1",
        name: "weather",
        output: "Sunny, 72F",
        remoteUrl: "http://127.0.0.1:4001",
        sessionId: "s0",
        status: "completed",
        turnIndex: 0,
      },
      {
        callId: "c2",
        childSessionId: "child-c1",
        name: "weather",
        output: undefined,
        remoteUrl: "http://127.0.0.1:4001",
        sessionId: "s0",
        status: "working",
        turnIndex: 1,
      },
    ]);
  });

  it("does not count agents a workflow tool's task opens as agent tool calls", () => {
    const facts = derive([
      taskStarted("c1", "agent_router", "agent_router-1"),
      agentStarted("c1", "weather"),
      taskStarted("c2", "deploy", "deploy-1"),
    ]);

    expect(facts.subagentCalls).toEqual([]);
  });

  it("captures failure code from session.failed event", () => {
    const events: UnstampedMessageStreamEvent[] = [
      {
        type: "session.failed",
        data: {
          code: "TIMEOUT",
          message: "Run timed out",
          sessionId: "s1",
        },
      },
    ];
    const facts = derive(events);
    expect(facts.failureCode).toBe("TIMEOUT");
  });

  it("collects HITL input requests", () => {
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      inputRequested(["r1", "r2"]),
    ];
    const facts = derive(events);
    expect(facts.inputRequests.map((request) => request.requestId)).toEqual(["r1", "r2"]);
  });

  it("marks the run parked when it ends on unanswered input requests", () => {
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      inputRequested(["r1"]),
      { type: "turn.completed", data: { sequence: 1, turnId: "t1" } },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ] as UnstampedMessageStreamEvent[];

    const facts = derive(events);
    expect(facts.parked).toBe(true);
  });

  it("does not mark the run parked when the turn continued past the input request", () => {
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      inputRequested(["r1"]),
      {
        type: "message.completed",
        data: { finishReason: "stop", message: "done", stepIndex: 1, turnId: "t1", sequence: 2 },
      },
      { type: "turn.completed", data: { sequence: 3, turnId: "t1" } },
      {
        type: "session.waiting",
        data: { continuationToken: "session-id", wait: "next-user-message" },
      },
    ] as UnstampedMessageStreamEvent[];

    const facts = derive(events);
    expect(facts.parked).toBe(false);
  });
});
