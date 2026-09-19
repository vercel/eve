import {
  registerWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
  findBlockingWorkflowToolRun,
  getBlockingWorkflowToolRuns,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";

const RECORD = {
  callId: "call_1",
  toolName: "deploy",
  lifetime: "turn" as const,
  origin: { turnId: "turn-1", stepIndex: 0 },
  address: { runId: "wrun_1", hookToken: "eve:workflow-tool-run:abc" },
};

function session(state?: HarnessSession["state"]): HarnessSession {
  return { state } as HarnessSession;
}

describe("workflow tool run records", () => {
  it("rejects the previous registry format before using its run records", () => {
    expect(() =>
      getBlockingWorkflowToolRuns({
        "eve.workflowTool": { version: 1, runs: [RECORD] },
      }),
    ).toThrow("Corrupt workflow tool run registry");
  });

  it("records, finds, and removes runs by call id", () => {
    const recorded = registerWorkflowToolRun(session({ other: true }), RECORD);
    expect(getBlockingWorkflowToolRuns(recorded.state)).toEqual([RECORD]);
    expect(findBlockingWorkflowToolRun(recorded.state, "call_1", "turn-1")).toEqual(RECORD);

    const replaced = registerWorkflowToolRun(recorded, {
      ...RECORD,
      address: { ...RECORD.address, runId: "wrun_2" },
    });
    expect(getBlockingWorkflowToolRuns(replaced.state)).toEqual([
      { ...RECORD, address: { ...RECORD.address, runId: "wrun_2" } },
    ]);

    const removed = removeBlockingWorkflowToolRuns(replaced, "turn-1", "call_1");
    expect(getBlockingWorkflowToolRuns(removed.state)).toEqual([]);
    expect(removed.state).toEqual({ other: true });
    expect(removeBlockingWorkflowToolRuns(removed, "turn-1", "call_1")).toBe(removed);
  });

  it("drops the state map entirely when nothing else is recorded", () => {
    const recorded = registerWorkflowToolRun(session(), RECORD);
    expect(removeBlockingWorkflowToolRuns(recorded, "turn-1").state).toBeUndefined();
    expect(removeBlockingWorkflowToolRuns(session(), "turn-1")).toEqual(session());
  });

  it("binds inbox tool results to the recorded run by call id and tool name", () => {
    const state = registerWorkflowToolRun(
      session({
        "eve.harness.emission": {
          turnId: "turn-1",
          sequence: 0,
          stepIndex: 0,
          sessionStarted: true,
        },
      }),
      RECORD,
    ).state;
    const result = {
      callId: "call_1",
      kind: "tool-result" as const,
      output: 1,
      toolName: "deploy",
    };

    expect(isInboxToolResultFromRecordedWorkflowToolRun(state, result)).toBe(true);
    expect(
      isInboxToolResultFromRecordedWorkflowToolRun(state, { ...result, toolName: "other" }),
    ).toBe(false);
    expect(
      isInboxToolResultFromRecordedWorkflowToolRun(state, { ...result, callId: "call_2" }),
    ).toBe(false);
    expect(isInboxToolResultFromRecordedWorkflowToolRun(undefined, result)).toBe(false);
  });

  it("finds a paused call after authorization has ended the visible turn", () => {
    const recorded = registerWorkflowToolRun(session(), RECORD);
    expect(findBlockingWorkflowToolRun(recorded.state, RECORD.callId)).toEqual(RECORD);
    const overlapping = registerWorkflowToolRun(recorded, {
      ...RECORD,
      origin: { turnId: "another-turn", stepIndex: 0 },
    });
    expect(findBlockingWorkflowToolRun(overlapping.state, RECORD.callId)).toBeUndefined();
    expect(findBlockingWorkflowToolRun(overlapping.state, RECORD.callId, "turn-1")).toEqual(RECORD);
  });

  it("rejects malformed state", () => {
    expect(() =>
      getBlockingWorkflowToolRuns({
        "eve.workflowTool": { version: 3, runs: { not: "an array" } },
      }),
    ).toThrow("Corrupt workflow tool run registry");
  });
});
