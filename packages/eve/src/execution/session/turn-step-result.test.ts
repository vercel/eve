import { describe, expect, it } from "vitest";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { setTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
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

function startWorker(session: HarnessSession, taskId: string): HarnessSession {
  return registerWorkflowToolRun(session, {
    callId: taskId,
    toolName: "worker",
    lifetime: "session",
    origin: { turnId: "earlier-turn", stepIndex: 0 },
    address: { runId: taskId, hookToken: taskId },
    task: {
      taskId,
      metadata: { kind: "subagent", name: "worker" },
      dispatchContext: { auth: { current: null, initiator: null } },
    },
  });
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
  it("yields while an earlier task is pending and reports all unreported usage with the final result", () => {
    const pending = startWorker(withUsage(session(), 100), "worker-1");
    const yielded = resolveSessionStepResult(
      { next: null, session: pending, settledTurn: { output: "Verification is running." } },
      {},
      "conversation",
      {},
    );
    expect(yielded).toMatchObject({ action: "park", completion: { kind: "yielded" } });
    const checkpoint = { ...pending, state: yielded.sessionState.snapshot.session.state };
    expect(takeSessionUsageDelta(checkpoint).delta.inputTokens).toBe(100);

    const completed = withUsage(
      {
        ...checkpoint,
        state: recordWorkflowTaskView(checkpoint.state, {
          taskId: "worker-1",
          metadata: { kind: "subagent", name: "worker" },
          status: "completed",
          lastOutput: { type: "result", data: "VERIFIED" },
        }),
      },
      150,
    );
    const settled = resolveSessionStepResult(
      { next: null, session: completed, settledTurn: { output: "VERIFIED" } },
      {},
      "conversation",
      {},
    );
    expect(settled).toMatchObject({
      action: "park",
      completion: { kind: "settled", output: "VERIFIED", usage: { inputTokens: 150 } },
    });
    expect(
      takeSessionUsageDelta({ ...completed, state: settled.sessionState.snapshot.session.state })
        .delta.inputTokens,
    ).toBe(0);
  });

  it("keeps yielding after one worker finishes while another remains pending", () => {
    const pending = startWorker(startWorker(session(), "worker-1"), "worker-2");
    const partiallyCompleted = {
      ...pending,
      state: recordWorkflowTaskView(pending.state, {
        taskId: "worker-1",
        metadata: { kind: "subagent", name: "worker" },
        status: "completed",
        lastOutput: { type: "result", data: "First result" },
      }),
    };
    expect(
      resolveSessionStepResult(
        { next: null, session: partiallyCompleted, settledTurn: { output: "Still working." } },
        {},
        "conversation",
        {},
      ),
    ).toMatchObject({ action: "park", completion: { kind: "yielded" } });
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
        }),
      };
      expect(
        resolveSessionStepResult(
          { next: null, session: finished, settledTurn: { output: "Unable to verify." } },
          {},
          "conversation",
          {},
        ),
      ).toMatchObject({
        action: "park",
        completion: { kind: "settled", output: "Unable to verify." },
      });
    },
  );

  it("reports a failed turn immediately even when its worker is still pending", () => {
    expect(
      resolveSessionStepResult(
        {
          next: null,
          session: startWorker(session(), "worker-1"),
          settledTurn: { isError: true, output: "Model failed" },
        },
        {},
        "conversation",
        {},
      ),
    ).toMatchObject({
      action: "park",
      completion: { kind: "settled", isError: true, output: "Model failed" },
    });
  });
});
