import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { SessionStateMap } from "#harness/types.js";
import {
  findBlockingWorkflowToolRun,
  getBlockingWorkflowToolRuns,
  registerWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
  type BlockingWorkflowToolRun,
} from "./workflow-tool-runs.js";

const waiting = (turnId: string, callId = "same-call"): BlockingWorkflowToolRun => ({
  lifetime: "turn",
  callId,
  toolName: "research",
  origin: { turnId, stepIndex: 0 },
  address: { runId: `run-${turnId}-${callId}`, hookToken: `hook-${turnId}-${callId}` },
});

const legacyBackgroundRun = {
  ...waiting("turn-a", "task-a"),
  lifetime: "session",
  task: {
    taskId: "task-a",
    metadata: { kind: "tool", name: "research" },
    dispatchContext: { auth: { current: null, initiator: null } },
  },
};

describe("turn-owned workflow tool runs", () => {
  it("stores runs under eve.workflowTool", () => {
    const first = waiting("turn-a");
    const second = waiting("turn-b");
    const initial: { state?: SessionStateMap } = {};
    const session = registerWorkflowToolRun(registerWorkflowToolRun(initial, first), second);
    expect(session.state).toEqual({
      "eve.workflowTool": { version: 3, runs: [first, second] },
    });
  });

  it("clears only one turn while retaining another turn", () => {
    let session: { state?: SessionStateMap } = registerWorkflowToolRun({}, waiting("turn-a"));
    session = registerWorkflowToolRun(session, waiting("turn-b"));
    session = removeBlockingWorkflowToolRuns(session, "turn-a");
    expect(getBlockingWorkflowToolRuns(session.state)).toEqual([waiting("turn-b")]);
    expect(findBlockingWorkflowToolRun(session.state, "same-call", "turn-a")).toBeUndefined();
    expect(findBlockingWorkflowToolRun(session.state, "same-call", "turn-b")).toEqual(
      waiting("turn-b"),
    );
    session = removeBlockingWorkflowToolRuns(session, "turn-b");
    expect(session.state).toBeUndefined();
  });

  it("removes a single call without clearing the rest of the turn", () => {
    let session: { state?: SessionStateMap } = registerWorkflowToolRun({}, waiting("turn-a", "a"));
    session = registerWorkflowToolRun(session, waiting("turn-a", "b"));
    session = removeBlockingWorkflowToolRuns(session, "turn-a", "a");
    expect(getBlockingWorkflowToolRuns(session.state, "turn-a")).toEqual([waiting("turn-a", "b")]);
  });

  it("binds a result without a turn only when exactly one turn owns the call", () => {
    let session: { state?: SessionStateMap } = registerWorkflowToolRun({}, waiting("turn-a"));
    expect(findBlockingWorkflowToolRun(session.state, "same-call")).toEqual(waiting("turn-a"));
    session = registerWorkflowToolRun(session, waiting("turn-b"));
    expect(findBlockingWorkflowToolRun(session.state, "same-call")).toBeUndefined();
  });

  it("drops background, malformed, and duplicate records without failing the session", () => {
    const state: SessionStateMap = {
      "eve.workflowTool": {
        version: 3,
        runs: [
          legacyBackgroundRun,
          { ...waiting("turn-a"), origin: { turnId: "turn-a", stepIndex: -1 } },
          waiting("turn-a"),
          waiting("turn-a"),
        ],
      },
    };
    expect(getBlockingWorkflowToolRuns(state)).toEqual([waiting("turn-a")]);
    const session = registerWorkflowToolRun({ state }, waiting("turn-b"));
    expect(session.state).toEqual({
      "eve.workflowTool": { version: 3, runs: [waiting("turn-a"), waiting("turn-b")] },
    });
  });

  it("reads runs restored in the workflow VM", () => {
    const state = { "eve.workflowTool": { version: 3, runs: [waiting("turn-a")] } };
    const restored = runInNewContext("JSON.parse(input)", { input: JSON.stringify(state) });
    expect(Object.getPrototypeOf(restored)).not.toBe(Object.prototype);
    expect(getBlockingWorkflowToolRuns(restored)).toEqual(state["eve.workflowTool"].runs);
    expect(() => registerWorkflowToolRun({ state: restored }, waiting("turn-b"))).not.toThrow();
  });

  it("does not change tool identity on replay", () => {
    const session = registerWorkflowToolRun({}, waiting("turn-a"));
    expect(() =>
      registerWorkflowToolRun(session, { ...waiting("turn-a"), toolName: "other" }),
    ).toThrow("Replayed invocation changed its tool identity");
  });

  it("ignores unrelated legacy state keys", () => {
    expect(getBlockingWorkflowToolRuns({ "eve.tasks": { version: 2, tasks: [] } })).toEqual([]);
    expect(getBlockingWorkflowToolRuns({ "eve.runtime.workflowToolRuns": [] })).toEqual([]);
  });
});
