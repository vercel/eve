import { describe, expect, it } from "vitest";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { setTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessSession, SettledTurn } from "#harness/types.js";
import { recordWorkflowTaskView, registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";

function session(): HarnessSession {
  return {
    agent: { modelReference: { id: "unused" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "detector",
    history: [],
    sessionId: "detector",
  };
}

function startWorker(
  session: HarnessSession,
  taskId: string,
  turnId = "current-turn",
): HarnessSession {
  return registerWorkflowToolRun(session, {
    callId: taskId,
    toolName: "worker",
    lifetime: "session",
    origin: { turnId, stepIndex: 0 },
    address: { runId: taskId, hookToken: taskId },
    task: {
      taskId,
      metadata: { kind: "subagent", name: "worker" },
      dispatchContext: { auth: { current: null, initiator: null } },
    },
  });
}

function endTurn(session: HarnessSession, settledTurn: SettledTurn, turnId = "current-turn") {
  return resolveSessionStepResult(
    { next: null, session, settledTurn },
    {},
    "conversation",
    {},
    turnId,
  );
}

function withUsage(session: HarnessSession, inputTokens: number): HarnessSession {
  const totals = {
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    sawCost: false,
  };
  return setTurnUsageState(session, { ...totals, session: totals, turnId: "current-turn" });
}

describe("delegated turn completion", () => {
  it("defers caller notification while a task is working and reports accumulated usage with the final result", () => {
    const pending = startWorker(withUsage(session(), 100), "worker-1");
    const parked = endTurn(pending, { output: "Verification is running." });
    expect(parked).toMatchObject({
      action: "park",
      settled: { output: "Verification is running.", notifyCaller: false },
    });
    const checkpoint = { ...pending, state: parked.sessionState.snapshot.session.state };
    expect(takeSessionUsageDelta(checkpoint).delta.inputTokens).toBe(100);

    const completed = withUsage(
      {
        ...checkpoint,
        state: recordWorkflowTaskView(checkpoint.state, {
          taskId: "worker-1",
          metadata: { kind: "subagent", name: "worker" },
          status: "completed",
          lastOutput: { type: "result", data: "VERIFIED" },
        }).state,
      },
      150,
    );
    // The worker's notification wakes a later turn, which gives the final answer.
    const settled = endTurn(completed, { output: "VERIFIED" }, "woken-turn");
    expect(settled).toMatchObject({
      action: "park",
      settled: {
        notifyCaller: true,
        output: "VERIFIED",
        usage: { inputTokens: 150 },
      },
    });
    expect(
      takeSessionUsageDelta({ ...completed, state: settled.sessionState.snapshot.session.state })
        .delta.inputTokens,
    ).toBe(0);
  });

  it("does not notify the caller after one worker finishes while another is working", () => {
    const pending = startWorker(startWorker(session(), "worker-1"), "worker-2");
    const partiallyCompleted = {
      ...pending,
      state: recordWorkflowTaskView(pending.state, {
        taskId: "worker-1",
        metadata: { kind: "subagent", name: "worker" },
        status: "completed",
        lastOutput: { type: "result", data: "First result" },
      }).state,
    };
    expect(endTurn(partiallyCompleted, { output: "Still working." })).toMatchObject({
      action: "park",
      settled: { notifyCaller: false },
    });
  });

  it("answers the caller when only work started by an earlier turn is still working", () => {
    const pending = startWorker(session(), "monitor", "earlier-turn");
    expect(endTurn(pending, { output: "Here is the report." })).toMatchObject({
      action: "park",
      settled: { notifyCaller: true, output: "Here is the report." },
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "allows a final response after a worker is %s",
    (status) => {
      const pending = startWorker(session(), "worker-1");
      const finished = {
        ...pending,
        state: recordWorkflowTaskView(pending.state, {
          taskId: "worker-1",
          metadata: { kind: "subagent", name: "worker" },
          ...(status === "failed"
            ? { status, lastOutput: { type: "error" as const, data: "Failed" } }
            : { status }),
        }).state,
      };
      expect(endTurn(finished, { output: "Unable to verify." })).toMatchObject({
        action: "park",
        settled: { notifyCaller: true, output: "Unable to verify." },
      });
    },
  );

  it("answers the caller with a final error even when its worker is still working", () => {
    expect(
      endTurn(startWorker(session(), "worker-1"), { isError: true, output: "Model failed" }),
    ).toMatchObject({
      action: "park",
      settled: { notifyCaller: true, isError: true, output: "Model failed" },
    });
  });
});
