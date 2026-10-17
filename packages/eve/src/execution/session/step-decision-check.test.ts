import { describe, expect, it } from "vitest";

import { decisionDisagreement, type TablesSay } from "#execution/session/step-decision-check.js";
import type { StepDecision, StepState } from "#execution/session/step-decision.js";

const state: StepState = {
  ended: false,
  queuedInput: false,
  requestIds: [],
  signIns: [],
  turnOpen: true,
  unreadInput: false,
  unweighedAnswers: false,
  workingTaskIds: [],
};
const calls = (dispatch: boolean): StepDecision => ({
  kind: "wait",
  pause: { callIds: ["call_1"], dispatch, on: "calls", taskToolCalls: [] },
});

describe("decisionDisagreement", () => {
  it.each<[string, StepDecision, TablesSay, StepState?]>([
    ["a park between turns", { kind: "park" }, "no-turn"],
    ["a run on the session's own work", { kind: "run" }, "session"],
    ["a run beside working tasks", { kind: "run" }, "work", { ...state, workingTaskIds: ["t_1"] }],
    ["calls whose run asked someone", calls(false), "person"],
    ["calls whose runs haven't started", calls(true), "session"],
    [
      "tasks whose task asked someone",
      { kind: "wait", pause: { on: "tasks", taskIds: [] } },
      "person",
    ],
  ])("agrees with %s", (_name, decision, tables, given = state) => {
    expect(decisionDisagreement(given, decision, tables)).toBeUndefined();
  });

  it.each<[StepDecision, TablesSay, string]>([
    [{ kind: "run" }, "work", "run-but-work"],
    [calls(false), "session", "wait-calls-but-session"],
    [
      { kind: "wait", pause: { attemptIds: [], on: "person", requestIds: [] } },
      "session",
      "wait-person-but-session",
    ],
    [{ kind: "park", turnOpen: true }, "session", "stranded"],
  ])("names %j beside tables that say %s", (decision, tables, named) => {
    expect(decisionDisagreement(state, decision, tables)).toBe(named);
  });
});
