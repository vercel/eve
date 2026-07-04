import { describe, expect, it } from "vitest";

import {
  applySubagentFanoutLimit,
  DEFAULT_SUBAGENT_MAX_CALLS_PER_STEP,
  resolveSubagentMaxCallsPerStep,
} from "#harness/subagent-fanout.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";

function createSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "test-token",
    history: [],
    sessionId: "test-session",
    ...overrides,
  };
}

function createSubagentAction(index: number): RuntimeSubagentCallActionRequest {
  return {
    callId: `call-${index}`,
    description: "Launch another copy.",
    input: { message: `work item ${index}` },
    kind: "subagent-call",
    name: "agent",
    nodeId: "__root__",
    subagentName: "agent",
  };
}

describe("resolveSubagentMaxCallsPerStep", () => {
  it("uses eve's default when the session has no override", () => {
    expect(resolveSubagentMaxCallsPerStep(createSession())).toBe(
      DEFAULT_SUBAGENT_MAX_CALLS_PER_STEP,
    );
  });

  it("uses a positive session override", () => {
    expect(resolveSubagentMaxCallsPerStep(createSession({ subagentMaxCallsPerStep: 8 }))).toBe(8);
  });
});

describe("applySubagentFanoutLimit", () => {
  it("uses configured per-step fan-out limits from the session", () => {
    const result = applySubagentFanoutLimit({
      actions: [createSubagentAction(1), createSubagentAction(2), createSubagentAction(3)],
      session: createSession({ subagentMaxCallsPerStep: 2 }),
    });

    expect(result.actions.map((action) => action.callId)).toEqual(["call-1", "call-2"]);
    expect(result.rejectedResults).toEqual([
      {
        callId: "call-3",
        isError: true,
        kind: "subagent-result",
        output: {
          code: "EVE_SUBAGENT_STEP_LIMIT_EXCEEDED",
          message:
            "This step requested 3 subagent calls, but eve allows 2. The first 2 were started. Retry the remaining work in a later step with at most 2 subagent calls.",
        },
        subagentName: "agent",
      },
    ]);
  });

  it("shares the per-step fan-out limit across split runtime action batches", () => {
    const session = createSession({ subagentMaxCallsPerStep: 1 });

    const first = applySubagentFanoutLimit({
      actions: [createSubagentAction(1)],
      session,
      step: { stepIndex: 0, turnId: "turn_0" },
    });

    const second = applySubagentFanoutLimit({
      actions: [createSubagentAction(2)],
      session: first.session,
      step: { stepIndex: 0, turnId: "turn_0" },
    });

    const nextStep = applySubagentFanoutLimit({
      actions: [createSubagentAction(3)],
      session: second.session,
      step: { stepIndex: 1, turnId: "turn_0" },
    });

    expect(first.actions.map((action) => action.callId)).toEqual(["call-1"]);
    expect(first.rejectedResults).toEqual([]);
    expect(second.actions).toEqual([]);
    expect(second.rejectedResults).toEqual([
      {
        callId: "call-2",
        isError: true,
        kind: "subagent-result",
        output: {
          code: "EVE_SUBAGENT_STEP_LIMIT_EXCEEDED",
          message:
            "This step requested 2 subagent calls, but eve allows 1. The first 1 were started. Retry the remaining work in a later step with at most 1 subagent calls.",
        },
        subagentName: "agent",
      },
    ]);
    expect(nextStep.actions.map((action) => action.callId)).toEqual(["call-3"]);
    expect(nextStep.rejectedResults).toEqual([]);
  });
});
