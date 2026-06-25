import { describe, expect, it } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import type { EveEvalDerivedFacts, EveEvalTaskResult, EveEvalToolCall } from "#evals/types.js";
import * as Run from "#evals/assertions/run.js";

function makeResult(overrides: {
  status?: EveEvalTaskResult["status"];
  events?: readonly HandleMessageStreamEvent[];
  derived?: Partial<EveEvalDerivedFacts>;
  output?: unknown;
}): EveEvalTaskResult {
  return {
    output: overrides.output ?? null,
    finalMessage: null,
    status: overrides.status ?? "completed",
    events: overrides.events ?? [],
    derived: { ...createEmptyDerivedFacts(), ...overrides.derived },
  };
}

function toolCall(name: string, input: EveEvalToolCall["input"] = {}): EveEvalToolCall {
  return { name, input, output: undefined, isError: false, status: "pending", turnIndex: 0 };
}

function completedToolCall(name: string): EveEvalToolCall {
  return { ...toolCall(name), isError: false, output: "ok", status: "completed" };
}

function message(text: string): HandleMessageStreamEvent {
  return {
    type: "message.completed",
    data: { finishReason: "stop", message: text, sequence: 1, stepIndex: 0, turnId: "t1" },
  } as HandleMessageStreamEvent;
}

function actionsRequested(
  actions: readonly { readonly callId: string; readonly toolName: string }[],
): HandleMessageStreamEvent {
  return {
    type: "actions.requested",
    data: {
      actions: actions.map((action) => ({ ...action, input: {}, kind: "tool-call" as const })),
      sequence: 1,
      stepIndex: 0,
      turnId: "t1",
    },
  };
}

function actionResult(callId: string, toolName: string): HandleMessageStreamEvent {
  return {
    type: "action.result",
    data: {
      result: { callId, kind: "tool-result", output: null, toolName },
      sequence: 2,
      status: "completed",
      stepIndex: 0,
      turnId: "t1",
    },
  };
}

describe("run assertions", () => {
  it("completed passes a clean run and fails a failed or parked run", async () => {
    expect((await Run.completed().evaluate(makeResult({ status: "completed" }))).score).toBe(1);
    expect((await Run.completed().evaluate(makeResult({ status: "failed" }))).score).toBe(0);
    expect((await Run.completed().evaluate(makeResult({ derived: { parked: true } }))).score).toBe(
      0,
    );
  });

  it("completed rejects failure events even when the terminal status is completed", async () => {
    const failedEvent = {
      type: "step.failed",
      data: {
        code: "STEP_FAILED",
        message: "step failed",
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      },
    } as HandleMessageStreamEvent;

    expect(
      (await Run.completed().evaluate(makeResult({ status: "completed", events: [failedEvent] })))
        .score,
    ).toBe(0);
  });

  it("messageIncludes matches substrings of completed messages", async () => {
    const result = makeResult({ events: [message("hello there")] });
    expect((await Run.messageIncludes("hello").evaluate(result)).score).toBe(1);
    expect((await Run.messageIncludes("absent").evaluate(result)).score).toBe(0);
  });

  it("calledTool matches by name and input, with an exact-count option", async () => {
    const result = makeResult({
      derived: { toolCalls: [toolCall("get_weather", { city: "SF" })], toolCallCount: 1 },
    });
    expect((await Run.calledTool("get_weather").evaluate(result)).score).toBe(1);
    expect(
      (await Run.calledTool("get_weather", { input: { city: "SF" } }).evaluate(result)).score,
    ).toBe(1);
    expect(
      (await Run.calledTool("get_weather", { input: { city: "NYC" } }).evaluate(result)).score,
    ).toBe(0);
    expect((await Run.calledTool("missing").evaluate(result)).score).toBe(0);
  });

  it("calledTool and notCalledTool match lifecycle status without treating pending as successful", async () => {
    const result = makeResult({
      derived: {
        toolCalls: [toolCall("guarded"), completedToolCall("done")],
        toolCallCount: 2,
      },
    });
    expect((await Run.calledTool("guarded", { status: "pending" }).evaluate(result)).score).toBe(1);
    expect((await Run.calledTool("guarded", { isError: false }).evaluate(result)).score).toBe(0);
    expect(
      (await Run.notCalledTool("guarded", { status: "completed" }).evaluate(result)).score,
    ).toBe(1);
  });

  it("toolOrder correlates requested and resolved calls by call id for both phases", async () => {
    const requested = actionsRequested([
      { callId: "call-a", toolName: "step-a" },
      { callId: "call-b", toolName: "step-b" },
    ]);
    const paired = makeResult({
      events: [requested, actionResult("call-a", "step-a"), actionResult("call-b", "step-b")],
    });
    const mispaired = makeResult({
      events: [requested, actionResult("call-b", "step-a"), actionResult("call-a", "step-b")],
    });

    expect(
      (await Run.toolOrder(["step-a", "step-b"], { phase: "both" }).evaluate(paired)).score,
    ).toBe(1);
    expect(
      (await Run.toolOrder(["step-a", "step-b"], { phase: "both" }).evaluate(mispaired)).score,
    ).toBe(0);
  });

  it("toolOrder requested phase ignores calls synthesized from result-only events", async () => {
    const result = makeResult({
      events: [actionResult("call-a", "step-a")],
      derived: { toolCalls: [completedToolCall("step-a")], toolCallCount: 1 },
    });

    expect((await Run.toolOrder(["step-a"]).evaluate(result)).score).toBe(0);
    expect((await Run.toolOrder(["step-a"], { phase: "resolved" }).evaluate(result)).score).toBe(1);
  });

  it("matches typed event counts and ordered event groups", async () => {
    const called = {
      type: "subagent.called",
      data: {
        name: "child",
        callId: "c",
        childSessionId: "s",
        sessionId: "p",
        sequence: 1,
        toolName: "subagent",
        turnId: "t",
        workflowId: "w",
      },
    } as HandleMessageStreamEvent;
    const completed = {
      type: "subagent.completed",
      data: { callId: "c", output: "ok", sequence: 2, subagentName: "child", turnId: "t" },
    } as HandleMessageStreamEvent;
    const result = makeResult({ events: [called, called, completed] });

    expect(
      (
        await Run.typedEvent({
          type: "subagent.called",
          data: { name: "child" },
          times: 2,
        }).evaluate(result)
      ).score,
    ).toBe(1);
    expect((await Run.notEvent({ type: "turn.failed" }).evaluate(result)).score).toBe(1);
    expect(
      (
        await Run.eventOrder([
          { type: "subagent.called", data: { name: "child" }, times: 2 },
          { type: "subagent.completed", data: { subagentName: "child" } },
        ]).evaluate(result)
      ).score,
    ).toBe(1);
  });

  it("loadedSkill matches a load_skill call by skill id", async () => {
    const result = makeResult({
      derived: {
        toolCalls: [toolCall("load_skill", { skill: "custom__talk-like-a-dog" })],
        toolCallCount: 1,
      },
    });
    expect((await Run.loadedSkill("custom__talk-like-a-dog").evaluate(result)).score).toBe(1);
    expect((await Run.loadedSkill("talk-like-a-dog").evaluate(result)).score).toBe(0);
    expect(Run.loadedSkill("custom__talk-like-a-dog").name).toBe(
      "loadedSkill(custom__talk-like-a-dog)",
    );
  });

  it("usedNoTools passes only with zero tool calls", async () => {
    expect((await Run.usedNoTools().evaluate(makeResult({}))).score).toBe(1);
    expect(
      (await Run.usedNoTools().evaluate(makeResult({ derived: { toolCallCount: 2 } }))).score,
    ).toBe(0);
  });
});
