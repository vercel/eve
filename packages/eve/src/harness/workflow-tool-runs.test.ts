import { registerWorkflowInvocation } from "#harness/workflow-invocations.js";
import { describe, expect, it } from "vitest";
import {
  clearWorkflowToolRuns,
  findWorkflowToolRun,
  getWorkflowToolRuns,
  isInboxToolResultFromRecordedWorkflowToolRun,
  removeWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import type { HarnessSession } from "#harness/types.js";

const RECORD = {
  callId: "call_1",
  toolName: "deploy",
  resultKind: "tool" as const,
  lifetime: "turn" as const,
  origin: { turnId: "turn-1", stepIndex: 0 },
  address: { runId: "wrun_1", hookToken: "eve:workflow-tool-run:abc" },
};

function session(state?: HarnessSession["state"]): HarnessSession {
  return { state } as HarnessSession;
}

describe("workflow tool run records", () => {
  it("records, finds, and removes runs by call id", () => {
    const recorded = registerWorkflowInvocation(session({ other: true }), RECORD);
    expect(getWorkflowToolRuns(recorded.state)).toEqual([RECORD]);
    expect(findWorkflowToolRun(recorded.state, "call_1", "turn-1")).toEqual(RECORD);

    const replaced = registerWorkflowInvocation(recorded, {
      ...RECORD,
      address: { ...RECORD.address, runId: "wrun_2" },
    });
    expect(getWorkflowToolRuns(replaced.state)).toEqual([
      { ...RECORD, address: { ...RECORD.address, runId: "wrun_2" } },
    ]);

    const removed = removeWorkflowToolRun(replaced, "call_1", "turn-1");
    expect(getWorkflowToolRuns(removed.state)).toEqual([]);
    expect(removed.state).toEqual({ other: true });
    expect(removeWorkflowToolRun(removed, "call_1", "turn-1")).toBe(removed);
  });

  it("drops the state map entirely when nothing else is recorded", () => {
    const recorded = registerWorkflowInvocation(session(), RECORD);
    expect(clearWorkflowToolRuns(recorded, "turn-1").state).toBeUndefined();
    expect(clearWorkflowToolRuns(session(), "turn-1")).toEqual(session());
  });

  it("binds inbox tool results to the recorded run by call id and tool name", () => {
    const state = registerWorkflowInvocation(
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
    const recorded = registerWorkflowInvocation(session(), RECORD);
    expect(findWorkflowToolRun(recorded.state, RECORD.callId)).toEqual(RECORD);
    const overlapping = registerWorkflowInvocation(recorded, {
      ...RECORD,
      origin: { turnId: "another-turn", stepIndex: 0 },
    });
    expect(findWorkflowToolRun(overlapping.state, RECORD.callId)).toBeUndefined();
    expect(findWorkflowToolRun(overlapping.state, RECORD.callId, "turn-1")).toEqual(RECORD);
  });

  it("rejects malformed state", () => {
    expect(() =>
      getWorkflowToolRuns({
        "eve.runtime.workflowInvocations": { version: 1, invocations: { not: "an array" } },
      }),
    ).toThrow("Corrupt workflow invocation registry");
  });
});
