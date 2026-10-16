import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { STEP_DECISIONS } from "#execution/session/step-decision.lean-table.js";
import {
  awaitsModel,
  decideStep,
  readStepState,
  type StepDecision,
  type StepState,
} from "#execution/session/step-decision.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { withParkedStep, withPublished } from "#internal/testing/session-machine.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

const PARTS = [
  "ended",
  "turnOpen",
  "queued",
  "unweighed",
  "requests",
  "signIns",
  "calls",
  "dispatch",
  "unread",
  "tasks",
] as const;
type Parts = Record<(typeof PARTS)[number], boolean>;

/** Every state `decideStep` can tell apart. `dispatch` means something only with `calls`. */
function everyState(): Parts[] {
  const states: Parts[] = [];
  for (let n = 0; n < 2 ** PARTS.length; n++) {
    const parts = Object.fromEntries(
      PARTS.map((part, index) => [part, (n & (1 << (PARTS.length - 1 - index))) !== 0]),
    ) as Parts;
    if (parts.calls || !parts.dispatch) states.push(parts);
  }
  return states;
}

function stepState(parts: Parts): StepState {
  return {
    ended: parts.ended,
    queuedInput: parts.queued,
    requestIds: parts.requests ? ["request_1"] : [],
    signIns: parts.signIns ? [{ attemptId: "attempt_1" }] : [],
    turnOpen: parts.turnOpen,
    unreadInput: parts.unread,
    unweighedAnswers: parts.unweighed,
    workingTaskIds: parts.tasks ? ["task_1"] : [],
    ...(parts.calls && {
      calls: { callIds: ["call_1"], dispatch: parts.dispatch, taskToolCalls: [] },
    }),
  };
}

function render(decision: StepDecision): string {
  switch (decision.kind) {
    case "end":
    case "run":
      return decision.kind;
    case "park":
      return decision.turnOpen === true ? "park open" : "park";
    case "wait":
      return decision.pause.on === "calls" && decision.pause.dispatch
        ? "wait calls dispatch"
        : `wait ${decision.pause.on}`;
  }
}

describe("decideStep", () => {
  // The table is the Lean model's decision for each state; `formal/` proves what it guarantees.
  it("decides every state as the Lean model does", () => {
    const model = new Map(
      STEP_DECISIONS.map((row) => {
        const [bits, decision] = row.split(" -> ");
        return [bits, decision];
      }),
    );
    const states = everyState();
    expect(model.size).toBe(states.length);
    for (const parts of states) {
      const bits = PARTS.map((part) => (parts[part] ? "1" : "0")).join(" ");
      expect(`${bits} -> ${render(decideStep(stepState(parts)))}`).toBe(
        `${bits} -> ${model.get(bits)}`,
      );
    }
  });
});

describe("readStepState", () => {
  const session: HarnessSession = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [],
    sessionId: "test-session",
  };
  const waitCall: ModelMessage = {
    content: [
      { input: {}, toolCallId: "wait-call", toolName: TASK_WAIT_TOOL_NAME, type: "tool-call" },
    ],
    role: "assistant",
  };
  const deployRun: RuntimeWorkflowTaskRequest = {
    callId: "deploy-call",
    entry: { entryPoint: "execute" },
    input: { service: "api" },
    kind: "workflow-task",
    toolName: "deploy",
    workflowId: "workflow//./agent/tools/deploy//execute",
  };
  const parked = (tasks: readonly RuntimeWorkflowTaskRequest[]) =>
    withParkedStep(session, {
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      messages: [waitCall],
      tasks,
    });

  it("waits on a task tool call without dispatching anything", () => {
    expect(readStepState(parked([])).calls).toMatchObject({
      callIds: ["wait-call"],
      dispatch: false,
    });
  });

  it("dispatches the workflow tool runs a batch holds beside its task tool calls", () => {
    expect(readStepState(parked([deployRun])).calls).toMatchObject({
      callIds: ["deploy-call", "wait-call"],
      dispatch: true,
    });
  });

  it("dispatches nothing once each run has started", () => {
    const runId = "test_turn_0_0";
    const started = withPublished(parked([deployRun]), [
      {
        data: {
          callId: "deploy-call",
          capability: { kind: "tool", name: "deploy" },
          owner: { runId },
        },
        scope: { runId, turnId: "turn_0" },
        type: "call.requested",
      },
      { data: { callId: "deploy-call" }, scope: { runId, turnId: "turn_0" }, type: "call.started" },
    ]);
    expect(readStepState(started).calls).toMatchObject({ dispatch: false });
  });
});

describe("awaitsModel", () => {
  const text = (value: string) => ({ text: value, type: "text" as const });
  const providerResult = {
    output: { type: "text" as const, value: "results" },
    toolCallId: "search",
    toolName: "web_search",
    type: "tool-result" as const,
  };

  it.each([
    ["a person's message", { content: "Hi", role: "user" as const }, true],
    [
      "a tool's result",
      { content: [{ ...providerResult, toolName: "lookup" }], role: "tool" as const },
      true,
    ],
    ["the model's reply", { content: [text("Done.")], role: "assistant" as const }, false],
    [
      "a provider's result after the model's text",
      { content: [text("Searching."), providerResult], role: "assistant" as const },
      true,
    ],
    [
      "the model's text after a provider's result",
      { content: [providerResult, text("Found it.")], role: "assistant" as const },
      false,
    ],
  ])("reads a history ending on %s", (_name, last, expected) => {
    expect(awaitsModel([last as HarnessModelMessage])).toBe(expected);
  });
});
