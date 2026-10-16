import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { STEP_DECISIONS } from "#execution/session/step-decision.lean-table.js";
import {
  decideStep,
  readStepState,
  type StepDecision,
  type StepState,
} from "#execution/session/step-decision.js";
import { withParkedStep } from "#internal/testing/session-machine.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

const PARTS = [
  "ended",
  "turnOpen",
  "again",
  "requests",
  "signIns",
  "calls",
  "dispatch",
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
    again: parts.again,
    ended: parts.ended,
    requestIds: parts.requests ? ["request_1"] : [],
    signIns: parts.signIns ? [{ attemptId: "attempt_1" }] : [],
    turnOpen: parts.turnOpen,
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
    expect(readStepState(parked([]), {}).calls).toMatchObject({
      callIds: ["wait-call"],
      dispatch: false,
    });
  });

  it("dispatches the workflow tool runs a batch holds beside its task tool calls", () => {
    expect(readStepState(parked([deployRun]), {}).calls).toMatchObject({
      callIds: ["deploy-call", "wait-call"],
      dispatch: true,
    });
  });
});
