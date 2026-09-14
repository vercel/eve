import { describe, expect, it } from "vitest";

import {
  clearWorkflowToolRuns,
  findWorkflowToolRun,
  getWorkflowToolRuns,
  isInboxToolResultFromRecordedWorkflowToolRun,
  recordWorkflowToolRun,
  removeWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import type { HarnessSession } from "#harness/types.js";

const RECORD = {
  callId: "call_1",
  hookToken: "eve:workflow-tool-run:abc",
  runId: "wrun_1",
  toolName: "deploy",
};

function session(state?: HarnessSession["state"]): HarnessSession {
  return { state } as HarnessSession;
}

describe("workflow tool run records", () => {
  it("records, finds, and removes runs by call id", () => {
    const recorded = recordWorkflowToolRun(session({ other: true }), RECORD);
    expect(getWorkflowToolRuns(recorded.state)).toEqual([RECORD]);
    expect(findWorkflowToolRun(recorded.state, "call_1")).toEqual(RECORD);

    const replaced = recordWorkflowToolRun(recorded, { ...RECORD, runId: "wrun_2" });
    expect(getWorkflowToolRuns(replaced.state)).toEqual([{ ...RECORD, runId: "wrun_2" }]);

    const removed = removeWorkflowToolRun(replaced, "call_1");
    expect(getWorkflowToolRuns(removed.state)).toEqual([]);
    expect(removed.state).toEqual({ other: true });
    expect(removeWorkflowToolRun(removed, "call_1")).toBe(removed);
  });

  it("drops the state map entirely when nothing else is recorded", () => {
    const recorded = recordWorkflowToolRun(session(), RECORD);
    expect(clearWorkflowToolRuns(recorded).state).toBeUndefined();
    expect(clearWorkflowToolRuns(session())).toEqual(session());
  });

  it("binds inbox tool results to the recorded run by call id and tool name", () => {
    const state = recordWorkflowToolRun(session(), RECORD).state;
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

  it("ignores malformed state", () => {
    expect(getWorkflowToolRuns({ "eve.runtime.workflowToolRuns": { not: "an array" } })).toEqual(
      [],
    );
  });
});
