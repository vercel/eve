import { describe, expect, it } from "vitest";

import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import type {
  EveEvalDerivedFacts,
  EveEvalSubagentCall,
  EveEvalTaskResult,
  EveEvalToolCall,
} from "#evals/types.js";
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
  return { name, input, output: undefined, status: "pending", turnIndex: 0 };
}

function completedToolCall(name: string): EveEvalToolCall {
  return { ...toolCall(name), output: "ok", status: "completed" };
}

function subagentCall(name: string, status: EveEvalSubagentCall["status"]): EveEvalSubagentCall {
  return {
    callId: `call-${status}`,
    childSessionId: `session-${status}`,
    name,
    output: status === "completed" ? "ok" : undefined,
    status,
    turnIndex: 0,
  };
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

function failedSubagentResult(input: {
  callId: string;
  output: unknown;
  subagentName: string;
}): HandleMessageStreamEvent {
  return {
    type: "action.result",
    data: {
      error: {
        code: "SUBAGENT_DEPTH_LIMIT",
        message: "Subagent depth limit reached",
      },
      result: {
        callId: input.callId,
        isError: true,
        kind: "subagent-result",
        output: input.output as never,
        subagentName: input.subagentName,
      },
      sequence: 2,
      status: "failed",
      stepIndex: 0,
      turnId: "t1",
    },
  };
}

describe("run assertions", () => {
  it("succeeded passes a clean run and fails a failed or parked run", async () => {
    expect((await Run.succeeded().evaluate(makeResult({ status: "completed" }))).score).toBe(1);
    expect((await Run.succeeded().evaluate(makeResult({ status: "failed" }))).score).toBe(0);
    expect((await Run.succeeded().evaluate(makeResult({ derived: { parked: true } }))).score).toBe(
      0,
    );
  });

  it("succeeded rejects failure events even when the terminal status is completed", async () => {
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
      (await Run.succeeded().evaluate(makeResult({ status: "completed", events: [failedEvent] })))
        .score,
    ).toBe(0);
  });

  it("parked requires a clean HITL park", async () => {
    expect((await Run.parked().evaluate(makeResult({ derived: { parked: true } }))).score).toBe(1);
    expect((await Run.parked().evaluate(makeResult({}))).score).toBe(0);
    expect(
      (await Run.parked().evaluate(makeResult({ status: "failed", derived: { parked: true } })))
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
      derived: {
        toolCalls: [{ ...completedToolCall("get_weather"), input: { city: "SF" } }],
        toolCallCount: 1,
      },
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

  it("calledTool accepts a predicate over the matching call count", async () => {
    const result = makeResult({
      derived: {
        toolCalls: [completedToolCall("get_weather"), completedToolCall("get_weather")],
        toolCallCount: 2,
      },
    });

    expect(
      (await Run.calledTool("get_weather", { count: (count) => count >= 2 }).evaluate(result))
        .score,
    ).toBe(1);
    expect(
      (await Run.calledTool("missing", { count: (count) => count === 0 }).evaluate(result)).score,
    ).toBe(1);
    const failed = await Run.calledTool("get_weather", {
      count: (count) => count > 2,
    }).evaluate(result);
    expect(failed.score).toBe(0);
    expect(failed.message).toContain("count predicate");
  });

  it("calledTool defaults to completed while notCalledTool rejects every lifecycle state", async () => {
    const result = makeResult({
      derived: {
        toolCalls: [toolCall("guarded"), completedToolCall("done")],
        toolCallCount: 2,
      },
    });
    expect((await Run.calledTool("guarded", { status: "pending" }).evaluate(result)).score).toBe(1);
    expect((await Run.calledTool("guarded").evaluate(result)).score).toBe(0);
    expect(
      (await Run.calledTool("done", { output: (value) => value === "ok" }).evaluate(result)).score,
    ).toBe(1);
    expect((await Run.notCalledTool("guarded").evaluate(result)).score).toBe(0);
    expect((await Run.notCalledTool("missing").evaluate(result)).score).toBe(1);
  });

  it("validates exact-count options", () => {
    expect(() => Run.calledTool("search", { count: -1 })).toThrow(/non-negative integer/);
    expect(() => Run.calledTool("search", { count: "1" as never })).toThrow(
      /non-negative integer or predicate/,
    );
    expect(() => Run.calledSubagent("child", { count: 1.5 })).toThrow(/non-negative integer/);
    expect(() => Run.typedEvent({ type: "turn.completed", count: Number.NaN })).toThrow(
      /non-negative integer/,
    );
  });

  it("calledSubagent matches every lifecycle status and exact counts", async () => {
    const result = makeResult({
      derived: {
        subagentCalls: [
          subagentCall("child", "pending"),
          subagentCall("child", "completed"),
          subagentCall("child", "failed"),
          subagentCall("child", "rejected"),
        ],
        subagentCallCount: 4,
      },
    });

    expect((await Run.calledSubagent("child").evaluate(result)).score).toBe(1);
    for (const status of ["pending", "completed", "failed", "rejected"] as const) {
      expect((await Run.calledSubagent("child", { status, count: 1 }).evaluate(result)).score).toBe(
        1,
      );
    }
    expect(
      (await Run.calledSubagent("child", { status: "completed", count: 2 }).evaluate(result)).score,
    ).toBe(0);
    expect(
      (
        await Run.calledSubagent("child", {
          count: (count) => count >= 4,
          status: "pending",
        }).evaluate(result)
      ).score,
    ).toBe(0);
    expect(
      (await Run.calledSubagent("child", { count: (count) => count === 1 }).evaluate(result)).score,
    ).toBe(1);
    expect(
      (
        await Run.calledSubagent("child", {
          callId: "call-completed",
          childSessionId: "session-completed",
          count: 1,
          status: "completed",
        }).evaluate(result)
      ).score,
    ).toBe(1);
  });

  it("toolOrder checks request order", async () => {
    const ordered = makeResult({
      events: [
        actionsRequested([
          { callId: "call-a", toolName: "step-a" },
          { callId: "call-b", toolName: "step-b" },
        ]),
      ],
    });
    const reversed = makeResult({
      events: [
        actionsRequested([
          { callId: "call-b", toolName: "step-b" },
          { callId: "call-a", toolName: "step-a" },
        ]),
      ],
    });

    expect((await Run.toolOrder(["step-a", "step-b"]).evaluate(ordered)).score).toBe(1);
    expect((await Run.toolOrder(["step-a", "step-b"]).evaluate(reversed)).score).toBe(0);
  });

  it("toolOrder ignores calls synthesized from result-only events", async () => {
    const result = makeResult({
      events: [actionResult("call-a", "step-a")],
      derived: { toolCalls: [completedToolCall("step-a")], toolCallCount: 1 },
    });

    expect((await Run.toolOrder(["step-a"]).evaluate(result)).score).toBe(0);
  });

  it("noFailedActions includes failed action details", async () => {
    const outcome = await Run.noFailedActions().evaluate(
      makeResult({
        events: [
          failedSubagentResult({
            callId: "call-a",
            output: "Subagent recursion stopped before LEVEL_4_REACHED",
            subagentName: "agent",
          }),
        ],
      }),
    );

    expect(outcome.score).toBe(0);
    expect(outcome.message).toContain("subagent-result");
    expect(outcome.message).toContain("agent");
    expect(outcome.message).toContain("call-a");
    expect(outcome.message).toContain("Subagent depth limit reached");
    expect(outcome.message).toContain("Subagent recursion stopped");
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
          count: 2,
        }).evaluate(result)
      ).score,
    ).toBe(1);
    expect(
      (
        await Run.typedEvent({
          type: "subagent.called",
          data: { name: "child" },
          count: (count) => count >= 2,
        }).evaluate(result)
      ).score,
    ).toBe(1);
    expect((await Run.notEvent({ type: "turn.failed" }).evaluate(result)).score).toBe(1);
    expect(
      (
        await Run.eventOrder([
          { type: "subagent.called", data: { name: "child" }, count: 2 },
          { type: "subagent.completed", data: { subagentName: "child" } },
        ]).evaluate(result)
      ).score,
    ).toBe(1);
    expect(
      (
        await Run.eventOrder([
          {
            type: "subagent.called",
            data: { name: "child" },
            count: (count) => count >= 2,
          },
          {
            type: "subagent.completed",
            data: { subagentName: "child" },
            count: (count) => count >= 1,
          },
        ]).evaluate(result)
      ).score,
    ).toBe(1);
    expect(
      (
        await Run.eventsSatisfy(
          "completion follows delegation",
          (events) => events.at(-1)?.type === "subagent.completed",
        ).evaluate(result)
      ).score,
    ).toBe(1);
  });

  it("eventOrder rejects interleaved event groups", async () => {
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
    const result = makeResult({ events: [called, completed, called] });

    expect(
      (
        await Run.eventOrder([
          { type: "subagent.called", data: { name: "child" }, count: 2 },
          { type: "subagent.completed", data: { subagentName: "child" } },
        ]).evaluate(result)
      ).score,
    ).toBe(0);
  });

  it("loadedSkill matches a load_skill call by skill id", async () => {
    const result = makeResult({
      derived: {
        toolCalls: [
          {
            ...completedToolCall("load_skill"),
            input: { skill: "custom__talk-like-a-dog" },
          },
        ],
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
