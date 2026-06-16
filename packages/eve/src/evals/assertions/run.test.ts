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
  return { name, input, output: undefined, isError: false, turnIndex: 0 };
}

function message(text: string): HandleMessageStreamEvent {
  return {
    type: "message.completed",
    data: { finishReason: "stop", message: text, sequence: 1, stepIndex: 0, turnId: "t1" },
  } as HandleMessageStreamEvent;
}

describe("run assertions", () => {
  it("completed passes a clean run and fails a failed or parked run", async () => {
    expect((await Run.completed().evaluate(makeResult({ status: "completed" }))).score).toBe(1);
    expect((await Run.completed().evaluate(makeResult({ status: "failed" }))).score).toBe(0);
    expect((await Run.completed().evaluate(makeResult({ derived: { parked: true } }))).score).toBe(
      0,
    );
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

  it("usedNoTools passes only with zero tool calls", async () => {
    expect((await Run.usedNoTools().evaluate(makeResult({}))).score).toBe(1);
    expect(
      (await Run.usedNoTools().evaluate(makeResult({ derived: { toolCallCount: 2 } }))).score,
    ).toBe(0);
  });
});
