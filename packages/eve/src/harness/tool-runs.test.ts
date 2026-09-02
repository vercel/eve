import { describe, expect, it } from "vitest";

import {
  clearToolRuns,
  findToolRun,
  getToolRuns,
  isInboxToolResultFromRecordedRun,
  recordToolRun,
  removeToolRun,
} from "#harness/tool-runs.js";
import type { HarnessSession } from "#harness/types.js";

const RECORD = {
  callId: "call_1",
  hookToken: "eve:tool-run:abc",
  runId: "wrun_1",
  toolName: "deploy",
};

function session(state?: HarnessSession["state"]): HarnessSession {
  return { state } as HarnessSession;
}

describe("tool run records", () => {
  it("records, finds, and removes runs by call id", () => {
    const recorded = recordToolRun(session({ other: true }), RECORD);
    expect(getToolRuns(recorded.state)).toEqual([RECORD]);
    expect(findToolRun(recorded.state, "call_1")).toEqual(RECORD);

    const replaced = recordToolRun(recorded, { ...RECORD, runId: "wrun_2" });
    expect(getToolRuns(replaced.state)).toEqual([{ ...RECORD, runId: "wrun_2" }]);

    const removed = removeToolRun(replaced, "call_1");
    expect(getToolRuns(removed.state)).toEqual([]);
    expect(removed.state).toEqual({ other: true });
    expect(removeToolRun(removed, "call_1")).toBe(removed);
  });

  it("drops the state map entirely when nothing else is recorded", () => {
    const recorded = recordToolRun(session(), RECORD);
    expect(clearToolRuns(recorded).state).toBeUndefined();
    expect(clearToolRuns(session())).toEqual(session());
  });

  it("binds inbox tool results to the recorded run by call id and tool name", () => {
    const state = recordToolRun(session(), RECORD).state;
    const result = {
      callId: "call_1",
      kind: "tool-result" as const,
      output: 1,
      toolName: "deploy",
    };

    expect(isInboxToolResultFromRecordedRun(state, result)).toBe(true);
    expect(isInboxToolResultFromRecordedRun(state, { ...result, toolName: "other" })).toBe(false);
    expect(isInboxToolResultFromRecordedRun(state, { ...result, callId: "call_2" })).toBe(false);
    expect(isInboxToolResultFromRecordedRun(undefined, result)).toBe(false);
  });

  it("ignores malformed state", () => {
    expect(getToolRuns({ "eve.runtime.toolRuns": { not: "an array" } })).toEqual([]);
  });
});
