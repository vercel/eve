import { expect, it } from "vitest";

import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

function stream(events: readonly SessionEvent[]): SessionStreamEvent[] {
  return events.map((event, line) => ({
    ...event,
    meta: { at: "2026-10-09T00:00:00.000Z", position: { index: 0, line } },
  }));
}

it("reads a call when two readers of one turn recorded its events out of order", () => {
  const scope = { runId: "run_0", turnId: "turn_0" };
  const events = stream([
    {
      data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
      type: "turn.started",
    },
    {
      data: {
        callId: "call_sleep",
        capability: { kind: "tool", name: "sleep" },
        input: {},
        owner: { runId: "run_0" },
      },
      scope,
      type: "call.requested",
    },
    {
      data: { callId: "call_sleep", outcome: "completed", output: { interrupted: true } },
      scope,
      type: "call.settled",
    },
  ]);
  // The steering message's reader recorded the turn's later lines before the first reader's.
  const usageEvents = [...events.slice(2), ...events];

  expect(deriveRunFacts(events, { usageEvents }).toolCalls).toMatchObject([
    { name: "sleep", output: { interrupted: true }, status: "completed" },
  ]);
});

const turn0 = { turnId: "turn_0" };
const run0 = { runId: "run_0", turnId: "turn_0" };
const turn1 = { turnId: "turn_1" };
const run1 = { runId: "run_1", turnId: "turn_1" };
const spent = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 100, outputTokens: 10 };

function call(callId: string, kind: string, name: string, owner = run0): SessionEvent {
  return {
    data: {
      callId,
      capability: { kind, name },
      input: { id: callId },
      owner: { runId: owner.runId },
    },
    scope: owner,
    type: "call.requested",
  } as SessionEvent;
}

function done(callId: string, output: unknown, owner = run0): SessionEvent {
  return {
    data: { callId, outcome: "completed", output },
    scope: owner,
    type: "call.settled",
  } as SessionEvent;
}

/** A turn that calls a tool, loads a skill, starts a subagent, and pauses on an approval. */
const firstTurn: SessionEvent[] = [
  { data: {}, type: "session.started" },
  {
    data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
    scope: turn0,
    type: "turn.started",
  },
  { data: { owner: turn0, runId: "run_0" }, scope: run0, type: "model.requested" },
  {
    data: { attempt: 0, modelId: "big-model", runId: "run_0" },
    scope: run0,
    type: "model.started",
  },
  {
    data: { kind: "reasoning", partId: "p_0", phase: "narration", runId: "run_0", value: "Plan." },
    scope: run0,
    type: "content.completed",
  },
  call("call_weather", "tool", "weather"),
  call("call_skill", "skill", "deploy-guide"),
  call("call_research", "agent", "research"),
  call("call_deploy", "tool", "deploy"),
  done("call_weather", { temperature: 4 }),
  done("call_skill", "Loaded."),
  {
    data: {
      kind: "agent",
      name: "research",
      startedBy: { callId: "call_research" },
      taskId: "task_0",
    },
    scope: turn0,
    type: "task.started",
  },
  { data: { callId: "call_research", taskId: "task_0" }, scope: run0, type: "call.started" },
  {
    data: {
      name: "research",
      owner: { taskId: "task_0" },
      sessionId: "child_0",
      stream: "/child_0",
    },
    scope: turn0,
    type: "child.opened",
  },
  {
    data: {
      interactionId: "i_0",
      request: {
        kind: "approval",
        options: [{ id: "approve", label: "Approve" }],
        prompt: "Deploy?",
      },
      subject: { callId: "call_deploy" },
    },
    scope: turn0,
    type: "interaction.opened",
  },
  { data: { outcome: "completed", runId: "run_0" }, scope: run0, type: "model.settled" },
  { data: { kind: "model", owner: { runId: "run_0" }, usage: spent }, type: "usage.recorded" },
  {
    data: { awaiting: [{ interactionId: "i_0" }], turnId: "turn_0" },
    scope: turn0,
    type: "turn.paused",
  },
] as SessionEvent[];

/** The approval's answer runs the call; the next turn replies and fails. */
const secondTurn: SessionEvent[] = [
  {
    data: { cause: { responseId: "r_0" }, interactionId: "i_0", outcome: "accepted" },
    scope: turn0,
    type: "interaction.settled",
  },
  done("call_deploy", "deployed"),
  { data: { outcome: "completed", turnId: "turn_0" }, scope: turn0, type: "turn.settled" },
  {
    data: { cause: { deliveryId: "d_1" }, follows: "turn_0", turnId: "turn_1" },
    scope: turn1,
    type: "turn.started",
  },
  { data: { owner: turn1, runId: "run_1" }, scope: run1, type: "model.requested" },
  {
    data: { attempt: 0, modelId: "small-model", runId: "run_1" },
    scope: run1,
    type: "model.started",
  },
  {
    data: { kind: "text", partId: "p_1", phase: "reply", runId: "run_1", value: "Deployed." },
    scope: run1,
    type: "content.completed",
  },
  { data: { outcome: "completed", runId: "run_1" }, scope: run1, type: "model.settled" },
  { data: { kind: "model", owner: { runId: "run_1" }, usage: spent }, type: "usage.recorded" },
  {
    data: {
      error: { code: "BUDGET_EXCEEDED", message: "Out of budget" },
      outcome: "failed",
      turnId: "turn_1",
    },
    scope: turn1,
    type: "turn.settled",
  },
] as SessionEvent[];

it("reads what a turn did: its calls by kind, the request it waits on, and its models", () => {
  const events = stream(firstTurn);

  expect(deriveRunFacts(events, { sessionId: "s" })).toMatchObject({
    failureCode: undefined,
    interactions: [{ interactionId: "i_0" }],
    messageCount: 0,
    models: ["big-model"],
    parked: true,
    reasoningBlockCount: 1,
    skillLoads: [{ sessionId: "s", skill: "deploy-guide", status: "completed", turnIndex: 0 }],
    subagentCalls: [
      { callId: "call_research", childSessionId: "child_0", name: "research", status: "pending" },
    ],
    toolCallCount: 3,
    toolCalls: [
      {
        callId: "call_weather",
        input: { id: "call_weather" },
        output: { temperature: 4 },
        status: "completed",
      },
      // An agent call reports the input the model sent its tool.
      {
        callId: "call_research",
        input: { id: "call_research" },
        name: "research",
        status: "pending",
      },
      { callId: "call_deploy", name: "deploy", status: "pending" },
    ],
    usage: { inputTokens: 100, outputTokens: 10 },
  });
});

it("counts a call an earlier turn asked for when this segment settles it, and the session's usage so far", () => {
  const all = stream([...firstTurn, ...secondTurn]);
  const segment = all.slice(firstTurn.length);

  expect(deriveRunFacts(segment, { usageEvents: all })).toMatchObject({
    failureCode: "BUDGET_EXCEEDED",
    interactions: [],
    messageCount: 1,
    models: ["small-model"],
    parked: false,
    toolCalls: [{ callId: "call_deploy", output: "deployed", status: "completed" }],
    usage: { inputTokens: 200, outputTokens: 20 },
  });
});

it("does not mark a later completed turn parked on an earlier interaction in a sparse history", () => {
  const events = stream([
    ...firstTurn,
    { type: "turn.settled", scope: turn0, data: { turnId: "turn_0", outcome: "cancelled" } },
    {
      type: "turn.started",
      scope: turn1,
      data: { turnId: "turn_1", follows: "turn_0", cause: { deliveryId: "d_1" } },
    },
    { type: "turn.settled", scope: turn1, data: { turnId: "turn_1", outcome: "completed" } },
  ]);
  expect(deriveRunFacts(events).parked).toBe(false);
});

it("marks a later parent turn parked on a relayed child interaction", () => {
  const events = stream([
    ...firstTurn,
    { type: "turn.settled", scope: turn0, data: { turnId: "turn_0", outcome: "cancelled" } },
    {
      type: "turn.started",
      scope: turn1,
      data: { turnId: "turn_1", follows: "turn_0", cause: { deliveryId: "d_1" } },
    },
    {
      type: "interaction.opened",
      scope: turn1,
      data: {
        interactionId: "relayed",
        subject: { callId: "call_research" },
        origin: { sessionId: "child_0", interactionId: "child_approval" },
        request: { kind: "approval", prompt: "Deploy the child's change?" },
      },
    },
    {
      type: "turn.paused",
      scope: turn1,
      data: { turnId: "turn_1", awaiting: [{ interactionId: "relayed" }] },
    },
  ]);
  expect(deriveRunFacts(events).parked).toBe(true);
});

it("counts a responder's sign-in as an interaction requiring input", () => {
  const events = stream([
    ...firstTurn,
    {
      type: "interaction.opened",
      scope: turn0,
      data: {
        interactionId: "sign_in",
        subject: { responseId: "r_0" },
        request: { kind: "sign-in", prompt: "Sign in to approve.", signIn: { name: "deploy" } },
      },
    },
    {
      type: "turn.paused",
      scope: turn0,
      data: { turnId: "turn_0", awaiting: [{ interactionId: "sign_in" }] },
    },
  ]);
  expect(deriveRunFacts(events).parked).toBe(true);
});

// https://github.com/vercel/eve/issues/5157
it("reads a partial answer's segment as parked on the request it left open", () => {
  const approval = (interactionId: string, callId: string): SessionEvent =>
    ({
      data: {
        interactionId,
        request: {
          kind: "approval",
          options: [{ id: "approve", label: "Approve" }],
          prompt: `Deploy ${callId}?`,
        },
        subject: { callId },
      },
      scope: turn0,
      type: "interaction.opened",
    }) as SessionEvent;
  const asked: SessionEvent[] = [
    {
      data: { cause: { deliveryId: "d_0" }, follows: null, turnId: "turn_0" },
      scope: turn0,
      type: "turn.started",
    },
    call("call_api", "tool", "deploy_service"),
    call("call_web", "tool", "deploy_service"),
    approval("i_api", "call_api"),
    approval("i_web", "call_web"),
    {
      data: {
        awaiting: [{ interactionId: "i_api" }, { interactionId: "i_web" }],
        turnId: "turn_0",
      },
      scope: turn0,
      type: "turn.paused",
    },
  ] as SessionEvent[];
  const answered: SessionEvent[] = [
    {
      data: { cause: { responseId: "r_api" }, interactionId: "i_api", outcome: "accepted" },
      scope: turn0,
      type: "interaction.settled",
    },
    done("call_api", "deployed"),
    {
      data: { awaiting: [{ interactionId: "i_web" }], turnId: "turn_0" },
      scope: turn0,
      type: "turn.paused",
    },
  ] as SessionEvent[];
  const all = stream([...asked, ...answered]);
  const segment = all.slice(asked.length);

  expect(deriveRunFacts(segment, { usageEvents: all })).toMatchObject({
    interactions: [],
    parked: true,
    toolCalls: [{ callId: "call_api", output: "deployed", status: "completed" }],
  });
});
