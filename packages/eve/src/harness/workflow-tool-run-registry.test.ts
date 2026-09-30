import { describe, expect, it } from "vitest";
import type { SessionStateMap } from "#harness/types.js";
import {
  findBlockingWorkflowToolRun,
  getBlockingWorkflowToolRuns,
  registerWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
  type BlockingWorkflowToolRun,
} from "./workflow-tool-runs.js";

const waiting = (turnId: string): BlockingWorkflowToolRun => ({
  callId: "same-call",
  toolName: "research",
  origin: { turnId, stepIndex: 0 },
  address: { runId: `run-${turnId}`, hookToken: `hook-${turnId}` },
});

describe("workflow tool run registry", () => {
  it("stores waiting runs under eve.workflowTool", () => {
    const first = waiting("turn-a");
    const second = waiting("turn-b");
    const initial: { state?: SessionStateMap } = {};
    const session = registerWorkflowToolRun(registerWorkflowToolRun(initial, first), second);
    expect(session.state).toEqual({
      "eve.workflowTool": { version: 4, runs: [first, second] },
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
    expect(removeBlockingWorkflowToolRuns(session, "turn-b").state).toBeUndefined();
  });

  it("rejects duplicate originating call identities", () => {
    expect(() =>
      getBlockingWorkflowToolRuns({
        "eve.workflowTool": {
          version: 4,
          runs: [waiting("turn-a"), waiting("turn-a")],
        },
      }),
    ).toThrow("Run identities must be unique");
  });

  it("does not change tool identity on replay", () => {
    const session = registerWorkflowToolRun({}, waiting("turn-a"));
    expect(() =>
      registerWorkflowToolRun(session, { ...waiting("turn-a"), toolName: "deploy" }),
    ).toThrow("Replayed invocation changed its tool identity");
  });

  it.each([
    ["the task-only index", { "eve.tasks": { version: 2, tasks: [] } }],
    ["the separate blocking-run store", { "eve.runtime.workflowToolRuns": [] }],
  ])("rejects %s", (_, state) => {
    expect(() => getBlockingWorkflowToolRuns(state)).toThrow("Unsupported workflow tool run state");
  });
});
