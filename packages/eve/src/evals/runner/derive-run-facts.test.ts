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

function subagentResult(input: {
  callId: string;
  subagentName: string;
  output: unknown;
  status: "completed" | "failed" | "rejected";
}): UnstampedMessageStreamEvent {
  return {
    type: "action.result",
    data: {
      result: {
        callId: input.callId,
        kind: "subagent-result",
        origin: "child",
        outcome: {
          kind: "terminal",
          result: { kind: "succeeded", output: input.output as never },
          usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
        },
        output: input.output as never,
        subagentName: input.subagentName,
      },
      sequence: 1,
      stepIndex: 0,
      status: input.status,
      turnId: "t1",
    },
  };
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

  it("settles a subagent call from the tool result of the same call id", () => {
    const facts = derive([
      turnStarted("t1", 0),
      actionsRequested([
        { callId: "ok", toolName: "reviewer" },
        { callId: "bad", toolName: "reviewer" },
      ]),
      taskStarted({ callId: "ok", name: "reviewer" }),
      taskStarted({ callId: "bad", name: "reviewer" }),
      actionResult({ callId: "ok", output: "Looks good.", toolName: "reviewer" }),
      actionResult({ callId: "bad", isError: true, output: "boom", toolName: "reviewer" }),
    ]);

    expect(
      facts.subagentCalls.map(({ callId, output, status }) => ({ callId, output, status })),
    ).toEqual([
      { callId: "ok", output: "Looks good.", status: "completed" },
      { callId: "bad", output: "boom", status: "failed" },
    ]);
  });

  it("joins task.started with task.settled by call id", () => {
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      taskStarted({ callId: "c1", name: "weather", remoteUrl: "http://127.0.0.1:4001" }),
      {
        type: "task.settled",
        data: {
          callId: "c1",
          generation: 1,
          output: "Sunny, 72F",
          status: "completed",
          taskId: "weather-c1",
        },
      },
    ];

    const facts = derive(events, { sessionId: "s0" });
    expect(facts.subagentCalls).toEqual([
      {
        callId: "c1",
        taskId: "weather-c1",
        generation: 1,
        childSessionId: "child-c1",
        name: "weather",
        remoteUrl: "http://127.0.0.1:4001",
        output: "Sunny, 72F",
        status: "completed",
        turnIndex: 0,
        sessionId: "s0",
      },
    ]);
    expect(facts.subagentCallCount).toBe(1);
  });

  it("gives each generation of a resumable task its own call, and marks them all when it ends", () => {
    const facts = derive([
      turnStarted("t1", 0),
      taskStarted({ callId: "c1", mode: "detached", name: "writer" }),
      {
        type: "task.settled",
        data: {
          callId: "c1",
          generation: 1,
          output: "Draft.",
          status: "completed",
          taskId: "writer-c1",
        },
      },
      taskStarted({
        callId: "c2",
        generation: 2,
        mode: "detached",
        name: "writer",
        taskId: "writer-c1",
      }),
      // A settle for a generation the call did not start changes nothing.
      {
        type: "task.settled",
        data: {
          callId: "c2",
          generation: 1,
          output: "Stale.",
          status: "completed",
          taskId: "writer-c1",
        },
      },
      {
        type: "task.settled",
        data: {
          callId: "c2",
          generation: 2,
          output: "Revised.",
          status: "completed",
          taskId: "writer-c1",
        },
      },
      { type: "task.ended", data: { taskId: "writer-c1" } },
    ]);

    expect(facts.subagentCalls).toEqual([
      expect.objectContaining({ callId: "c1", ended: true, generation: 1, output: "Draft." }),
      expect.objectContaining({ callId: "c2", ended: true, generation: 2, output: "Revised." }),
    ]);
  });

  it("takes failure and cancellation from task.settled before the tool result", () => {
    const error = { code: "TIMED_OUT", message: "The task did not finish within its time limit." };
    const facts = derive([
      turnStarted("t1", 0),
      taskStarted({ callId: "failed", name: "researcher" }),
      taskStarted({ callId: "cancelled", name: "researcher" }),
      {
        type: "task.settled",
        data: {
          callId: "failed",
          generation: 1,
          error,
          status: "failed",
          taskId: "researcher-failed",
        },
      },
      {
        type: "task.settled",
        data: {
          callId: "cancelled",
          generation: 1,
          status: "cancelled",
          taskId: "researcher-cancelled",
        },
      },
      actionResult({ callId: "failed", isError: true, output: "boom", toolName: "researcher" }),
    ]);

    expect(
      facts.subagentCalls.map(({ callId, output, status }) => ({ callId, output, status })),
    ).toEqual([
      { callId: "failed", output: error, status: "failed" },
      { callId: "cancelled", output: undefined, status: "cancelled" },
    ]);
  });

  it("keeps a detached agent call working past its receipt until it settles", () => {
    const receipt = { status: "working", taskId: "researcher-d1" };
    const events: UnstampedMessageStreamEvent[] = [
      turnStarted("t1", 0),
      taskStarted({ callId: "d1", mode: "detached", name: "researcher" }),
      actionResult({ callId: "d1", output: receipt, toolName: "researcher" }),
    ];

    expect(
      derive(events).subagentCalls.map(({ callId, output, status }) => ({
        callId,
        output,
        status,
      })),
    ).toEqual([{ callId: "d1", output: undefined, status: "working" }]);
    const settled = derive([
      ...events,
      {
        type: "task.settled",
        data: {
          callId: "d1",
          generation: 1,
          output: "Found it.",
          status: "completed",
          taskId: "researcher-d1",
        },
      },
    ]);
    expect(settled.subagentCalls).toEqual([
      expect.objectContaining({ callId: "d1", output: "Found it.", status: "completed" }),
    ]);
    expect(settled.toolCalls).toEqual([
      expect.objectContaining({ name: "researcher", output: receipt, status: "completed" }),
    ]);
  });

  it("keeps a remote detached agent call working past a receipt that follows task.started", () => {
    const receipt = { status: "working", taskId: "billing-b1" };
    const facts = derive([
      turnStarted("t1", 0),
      taskStarted({
        callId: "b1",
        mode: "detached",
        name: "billing",
        remoteUrl: "https://billing.test",
      }),
      actionResult({ callId: "b1", output: receipt, toolName: "billing" }),
      {
        type: "task.settled",
        data: {
          callId: "b1",
          generation: 1,
          output: "Refunded.",
          status: "completed",
          taskId: "billing-b1",
        },
      },
    ]);

    expect(facts.subagentCalls).toEqual([
      expect.objectContaining({ callId: "b1", output: "Refunded.", status: "completed" }),
    ]);
  });

  it("records a detached agent call that fails before its child starts", () => {
    const error = { code: "START_FAILED", message: "Remote agent billing refused the call." };
    const facts = derive([
      turnStarted("t1", 0),
      actionsRequested([
        {
          callId: "b1",
          input: { message: "Refund order 42." },
          toolName: "billing",
        },
      ]),
      taskStarted({ callId: "b1", mode: "detached", name: "billing", unstarted: true }),
      {
        type: "task.settled",
        data: { callId: "b1", error, generation: 1, status: "failed", taskId: "billing-b1" },
      },
      { type: "task.ended", data: { taskId: "billing-b1" } },
    ]);

    expect(facts.subagentCalls).toEqual([
      expect.objectContaining({
        callId: "b1",
        ended: true,
        name: "billing",
        output: error,
        status: "failed",
      }),
    ]);
    expect(facts.subagentCalls[0]).not.toHaveProperty("childSessionId");
  });

  it("records a workflow tool call as a tool call, not a subagent call", () => {
    const facts = derive([
      turnStarted("t1", 0),
      actionsRequested([{ callId: "c1", toolName: "deploy" }]),
      {
        type: "task.started",
        data: {
          callId: "c1",
          generation: 1,
          kind: "workflow",
          mode: "attached",
          name: "deploy",
          resumable: false,
          taskId: "deploy-c1",
          turnId: "t1",
        },
      },
      {
        type: "task.settled",
        data: {
          callId: "c1",
          generation: 1,
          output: { deployed: true },
          status: "completed",
          taskId: "deploy-c1",
        },
      },
      actionResult({ callId: "c1", output: { deployed: true }, toolName: "deploy" }),
    ]);

    expect(facts.subagentCalls).toEqual([]);
    expect(facts.toolCalls).toEqual([
      expect.objectContaining({ name: "deploy", output: { deployed: true }, status: "completed" }),
    ]);
  });

  it("records no delegation for a workflow task", () => {
    const facts = derive([
      turnStarted("t1", 0),
      {
        type: "task.started",
        data: {
          callId: "c2",
          generation: 1,
          kind: "workflow",
          mode: "attached",
          name: "deploy",
          resumable: false,
          taskId: "deploy-c2",
          turnId: "t1",
        },
      },
    ]);

    expect(facts.subagentCalls).toEqual([]);
  });

  it("records an agent call that failed or was cancelled before its child started", () => {
    const facts = derive([
      turnStarted("t1", 0),
      actionsRequested([
        { callId: "c1", input: { message: "Find sources." }, toolName: "research" },
        { callId: "c2", input: { message: "Draft it.", taskId: null }, toolName: "writer" },
      ]),
      taskStarted({ callId: "c1", name: "research", unstarted: true }),
      taskStarted({ callId: "c2", name: "writer", unstarted: true }),
      {
        type: "task.settled",
        data: {
          callId: "c1",
          generation: 1,
          error: { code: "START_FAILED", message: "The child could not start." },
          status: "failed",
          taskId: "research-c1",
        },
      },
      {
        type: "task.settled",
        data: { callId: "c2", generation: 1, status: "cancelled", taskId: "writer-c2" },
      },
      actionResult({
        callId: "c1",
        isError: true,
        output: { code: "START_FAILED", message: "The child could not start." },
        toolName: "research",
      }),
    ]);

    expect(facts.subagentCalls).toEqual([
      expect.objectContaining({
        callId: "c1",
        name: "research",
        output: { code: "START_FAILED", message: "The child could not start." },
        status: "failed",
        taskId: "research-c1",
        turnIndex: 0,
      }),
      expect.objectContaining({
        callId: "c2",
        name: "writer",
        status: "cancelled",
        taskId: "writer-c2",
      }),
    ]);
  });

  it("keeps a workflow tool that failed to start a tool call", () => {
    const facts = derive([
      turnStarted("t1", 0),
      actionsRequested([{ callId: "c1", input: { service: "api" }, toolName: "deploy" }]),
      {
        type: "task.settled",
        data: {
          callId: "c1",
          generation: 1,
          error: { code: "START_FAILED", message: "The queue is unavailable." },
          status: "failed",
          taskId: "deploy-c1",
        },
      },
      actionResult({ callId: "c1", isError: true, output: "unavailable", toolName: "deploy" }),
    ]);

    expect(facts.subagentCalls).toEqual([]);
    expect(facts.toolCalls).toEqual([
      expect.objectContaining({ name: "deploy", status: "failed" }),
    ]);
  });

  it("derives failed subagent calls from result-only events", () => {
    const facts = derive([
      turnStarted("t1", 0),
      subagentResult({
        callId: "c1",
        subagentName: "weather",
        output: { code: "START_FAILED" },
        status: "failed",
      }),
    ]);

    expect(facts.subagentCalls).toEqual([
      {
        callId: "c1",
        name: "weather",
        output: { code: "START_FAILED" },
        status: "failed",
        turnIndex: 0,
        sessionId: undefined,
      },
    ]);
  });

  it("preserves explicit cancellation even when the action reports failure or a late completion", () => {
    const cancelled: UnstampedMessageStreamEvent = {
      type: "action.result",
      data: {
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
        status: "failed",
        result: {
          callId: "c1",
          kind: "subagent-result",
          origin: "child",
          subagentName: "researcher",
          isError: true,
          output: "The agent invocation was cancelled.",
          outcome: {
            kind: "parked",
            result: { kind: "cancelled" },
            usageDelta: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        },
      },
    };
    const lateCompletion: UnstampedMessageStreamEvent = {
      type: "task.settled",
      data: {
        callId: "c1",
        generation: 1,
        output: "late result",
        status: "completed",
        taskId: "researcher-c1",
      },
    };
    for (const events of [[cancelled], [cancelled, lateCompletion]]) {
      expect(derive(events).subagentCalls[0]).toMatchObject({
        status: "cancelled",
        output: "The agent invocation was cancelled.",
      });
    }
  });

  it("records every subagent invocation separately", () => {
    const facts = derive([
      taskStarted({ callId: "c1", name: "agent-a" }),
      taskStarted({ callId: "c2", name: "agent-a" }),
    ]);
    expect(facts.subagentCalls.map((call) => call.name)).toEqual(["agent-a", "agent-a"]);
    expect(facts.subagentCalls.map((call) => call.status)).toEqual(["working", "working"]);
    expect(facts.subagentCallCount).toBe(2);
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

function taskStarted(input: {
  readonly callId: string;
  readonly generation?: number;
  readonly mode?: "attached" | "detached";
  readonly name: string;
  readonly remoteUrl?: string;
  /** A start that failed before its child started names no child. */
  readonly unstarted?: true;
  readonly taskId?: string;
}): UnstampedMessageStreamEvent {
  const sessionId = `child-${input.callId}`;
  const data: Extract<UnstampedMessageStreamEvent, { type: "task.started" }>["data"] = {
    callId: input.callId,
    generation: input.generation ?? 1,
    kind: "agent",
    mode: input.mode ?? "attached",
    name: input.name,
    resumable: true,
    taskId: input.taskId ?? `${input.name}-${input.callId}`,
    turnId: "t1",
  };
  if (input.unstarted !== true) {
    data.child =
      input.remoteUrl === undefined
        ? { sessionId, streamPath: `/eve/v1/session/${sessionId}/stream` }
        : {
            remote: { url: input.remoteUrl },
            sessionId,
            streamPath: `/eve/v1/session/s0/subagents/${input.callId}/${sessionId}/stream`,
          };
  }
  return { type: "task.started", data };
}
