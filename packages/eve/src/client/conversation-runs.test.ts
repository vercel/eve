import { describe, expect, it } from "vitest";

import { defaultMessageReducer } from "#client/message-reducer.js";
import { reduceContentRun, selectContentRun } from "#client/content-run.js";
import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type Run = {
  id: string;
  kind: "text" | "reasoning";
  turnId: string;
  stepIndex: number;
  text: string;
  status: "streaming" | "done";
};
type RunState = { runs: Run[]; nextGeneration: Map<string, number> };

// Test-only view-neutral sketch for ordered run state. Production views share
// the run transition and selection, but retain different state layouts.
function projectRuns(state: RunState, event: UnstampedMessageStreamEvent): RunState {
  const kind = event.type.startsWith("reasoning.") ? "reasoning" : "text";
  if (
    event.type !== "message.appended" &&
    event.type !== "message.completed" &&
    event.type !== "reasoning.appended" &&
    event.type !== "reasoning.completed"
  ) {
    if (
      event.type === "step.completed" ||
      event.type === "turn.completed" ||
      event.type === "turn.cancelled"
    ) {
      return {
        ...state,
        runs: state.runs.map((run) =>
          run.status === "streaming" &&
          (event.type !== "step.completed" ||
            (run.turnId === event.data.turnId && run.stepIndex === event.data.stepIndex))
            ? { ...run, status: "done" }
            : run,
        ),
      };
    }
    return state;
  }
  const { turnId, stepIndex } = event.data;
  const base = `${kind}:${turnId}:${stepIndex}`;
  const previous = state.runs.findLast((run) => run.id === base || run.id.startsWith(`${base}#`));
  const isAppend = event.type === "message.appended" || event.type === "reasoning.appended";
  const value =
    event.type === "message.appended"
      ? event.data.messageDelta
      : event.type === "reasoning.appended"
        ? event.data.reasoningDelta
        : event.type === "reasoning.completed"
          ? event.data.reasoning
          : event.data.message;
  const changeInput = isAppend
    ? { type: "append" as const, delta: value ?? "" }
    : { type: "complete" as const, text: value };
  const selection = selectContentRun(previous, changeInput);
  if (selection === "ignore") return state;
  const current = selection === "current" ? previous : undefined;
  const change = reduceContentRun(current, changeInput);
  if (change.type === "ignore") return state;
  if (change.type === "remove") {
    return { ...state, runs: state.runs.filter((run) => run !== current) };
  }
  const generation = state.nextGeneration.get(base) ?? 0;
  const id = current?.id ?? (generation === 0 ? base : `${base}#${generation}`);
  const run: Run = {
    id,
    kind,
    turnId,
    stepIndex,
    text: change.run.text,
    status: change.run.status,
  };
  if (current) return { ...state, runs: state.runs.map((item) => (item === current ? run : item)) };
  const nextGeneration = new Map(state.nextGeneration);
  nextGeneration.set(base, generation + 1);
  return { ...state, runs: [...state.runs, run], nextGeneration };
}

function replay(events: UnstampedMessageStreamEvent[]) {
  const reducer = defaultMessageReducer();
  let web = reducer.initial();
  let common: RunState = { runs: [], nextGeneration: new Map() };
  for (const event of events) {
    common = projectRuns(common, event);
    web = reducer.reduce(web, event as EveAgentReducerEvent);
  }
  return {
    common: common.runs,
    web: web.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text" || part.type === "reasoning"),
  };
}

function started(stepIndex = 0): UnstampedMessageStreamEvent {
  return { type: "step.started", data: { modelId: "test", sequence: 0, stepIndex, turnId: "t0" } };
}
function appended(messageDelta: string): UnstampedMessageStreamEvent {
  return {
    type: "message.appended",
    data: { messageDelta, sequence: 0, stepIndex: 0, turnId: "t0" },
  };
}
function completed(message: string | null): UnstampedMessageStreamEvent {
  return {
    type: "message.completed",
    data: { finishReason: "stop", message, sequence: 0, stepIndex: 0, turnId: "t0" },
  };
}

function toWebParts(runs: readonly Run[]) {
  return runs.map((run) => ({
    state: run.status,
    stepIndex: run.stepIndex,
    text: run.text,
    type: run.kind,
  }));
}

function toTerminalBlocks(runs: readonly Run[]) {
  return runs.map((run) => ({
    body: run.text,
    id: run.id,
    kind: run.kind === "text" ? "assistant" : "reasoning",
    live: run.status === "streaming",
  }));
}

describe("view-neutral root run projection spike", () => {
  it("separates generations when the server reuses stepIndex (TUI already does)", () => {
    const result = replay([
      started(),
      appended("Before."),
      completed("Before."),
      started(),
      appended("After."),
      completed("After."),
    ]);
    expect(result.common.map(({ id, text }) => [id, text])).toEqual([
      ["text:t0:0", "Before."],
      ["text:t0:0#1", "After."],
    ]);
    // The web reducer keeps both runs, but does not expose stable run IDs.
    expect(result.web.map((part) => part.text)).toEqual(["Before.", "After."]);
    expect(toWebParts(result.common)).toEqual(result.web);
    expect(toTerminalBlocks(result.common)).toEqual([
      { body: "Before.", id: "text:t0:0", kind: "assistant", live: false },
      { body: "After.", id: "text:t0:0#1", kind: "assistant", live: false },
    ]);
  });

  it("reconciles completed text without deltas and partial deltas", () => {
    const result = replay([
      started(),
      appended("Hel"),
      completed("Hello"),
      started(1),
      {
        type: "message.completed",
        data: { finishReason: "stop", message: "World", sequence: 0, stepIndex: 1, turnId: "t0" },
      },
    ]);
    expect(result.common.map(({ text, status }) => [text, status])).toEqual([
      ["Hello", "done"],
      ["World", "done"],
    ]);
    expect(result.web.map((part) => part.text)).toEqual(["Hello", "World"]);
  });

  it("keeps an earlier completed run when a later reused index has a null completion", () => {
    const result = replay([
      started(),
      appended("First response."),
      completed("First response."),
      started(),
      appended("<eve-empty-delivery/>"),
      completed(null),
    ]);
    expect(result.common.map((run) => run.text)).toEqual(["First response."]);
    expect(result.web.map((part) => part.text)).toEqual(["First response."]);
  });

  it("shares text and reasoning identity while leaving visibility to each view", () => {
    const result = replay([
      started(),
      {
        type: "reasoning.appended",
        data: { reasoningDelta: "Thinking", sequence: 0, stepIndex: 0, turnId: "t0" },
      },
      {
        type: "reasoning.completed",
        data: { reasoning: "Thinking", sequence: 0, stepIndex: 0, turnId: "t0" },
      },
      appended("Answer"),
      completed("Answer"),
    ]);
    expect(toWebParts(result.common)).toEqual(result.web);
    expect(toTerminalBlocks(result.common).map(({ id, kind }) => [id, kind])).toEqual([
      ["reasoning:t0:0", "reasoning"],
      ["text:t0:0", "assistant"],
    ]);
  });

  it("closes incomplete content on a step boundary before a reused index", () => {
    const result = replay([
      started(),
      appended("Partial"),
      {
        type: "step.completed",
        data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId: "t0" },
      },
      started(),
      appended("Next"),
      completed("Next"),
    ]);
    expect(toWebParts(result.common)).toEqual(result.web);
    expect(result.common.map(({ id, text }) => [id, text])).toEqual([
      ["text:t0:0", "Partial"],
      ["text:t0:0#1", "Next"],
    ]);
  });

  it("closes only the named step when a delayed step completion arrives", () => {
    const result = replay([
      started(),
      appended("First"),
      started(1),
      {
        type: "message.appended",
        data: { messageDelta: "Second", sequence: 0, stepIndex: 1, turnId: "t0" },
      },
      {
        type: "step.completed",
        data: { finishReason: "tool-calls", sequence: 0, stepIndex: 0, turnId: "t0" },
      },
    ]);
    expect(toWebParts(result.common)).toEqual(result.web);
    expect(result.common.map(({ text, status }) => [text, status])).toEqual([
      ["First", "done"],
      ["Second", "streaming"],
    ]);
  });

  it("replaces a streamed reasoning draft in place when completion differs", () => {
    const result = replay([
      started(),
      {
        type: "reasoning.appended",
        data: { reasoningDelta: "Draft", sequence: 0, stepIndex: 0, turnId: "t0" },
      },
      {
        type: "reasoning.completed",
        data: { reasoning: "Revised", sequence: 0, stepIndex: 0, turnId: "t0" },
      },
    ]);
    expect(toWebParts(result.common)).toEqual(result.web);
    expect(result.common.map(({ id, text }) => [id, text])).toEqual([
      ["reasoning:t0:0", "Revised"],
    ]);
  });

  it("preserves multiple completed messages within one model-call step", () => {
    const result = replay([started(), completed("One"), completed("Two")]);
    // The harness can flush text before a tool and complete another message
    // in the same step, without another step.started event.
    expect(result.common.map((run) => run.text)).toEqual(["One", "Two"]);
    expect(toWebParts(result.common)).toEqual(result.web);
  });

  it("suppresses a channel-delivered reply marker when its completion is null", () => {
    const result = replay([started(), appended("<eve-empty-delivery/>"), completed(null)]);
    // The server deliberately uses null here to keep channel-delivered text out
    // of the session transcript. Both views now withdraw the streamed marker.
    expect(result.common).toEqual([]);
    expect(result.web).toEqual([]);
  });
});
