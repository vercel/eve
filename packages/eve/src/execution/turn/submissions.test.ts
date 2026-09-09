import { describe, expect, it } from "vitest";
import {
  accountPending,
  admitSubmissions,
  retireTaskSubmissions,
} from "#execution/turn/submissions.js";
import { createDurableSessionState } from "#execution/session/state.js";
import type {
  AcceptedSubmission,
  InitializedSessionCheckpoint,
  PendingSubmission,
} from "#execution/turn/types.js";

function message(eventId: string, taskId?: string): PendingSubmission {
  return {
    candidateRunId: `candidate-${eventId}`,
    submission: {
      eventId,
      acceptedDeploymentId: "deployment",
      command: {
        kind: "send",
        turnPolicy: "queue",
        payload: { message: eventId },
        caller:
          taskId === undefined
            ? undefined
            : {
                taskId,
                callId: eventId,
                subagentName: "child",
                replyTo: { kind: "session", token: "parent" },
              },
      },
    },
  };
}

const cancellation = (taskId: string, turnId?: string): AcceptedSubmission => ({
  eventId: "cancel",
  command: { kind: "cancel", taskId, turnId },
});
function checkpoint(
  changes: Partial<InitializedSessionCheckpoint> = {},
): InitializedSessionCheckpoint {
  return {
    writeId: "snapshot",
    writerRunId: "owner",
    phase: "running",
    serializedContext: {},
    deliveries: {},
    queue: [],
    state: createDurableSessionState({
      session: {
        sessionId: "session",
        continuationToken: "alias",
        history: [],
        agent: { modelReference: { id: "model" }, system: "", tools: [] },
        compaction: { threshold: 1000, recentWindowSize: 10 },
      },
    }),
    ...changes,
  };
}

describe("task-scoped submission cancellation", () => {
  it("retires the addressed task's queued and unconsumed input without touching another caller", () => {
    const queued = message("queued", "task-a");
    const unconsumed = message("input", "task-a");
    const other = message("other", "task-b");
    const initial = checkpoint({
      queue: [queued, other],
      inputs: [unconsumed],
      caller:
        other.submission.command.kind === "send" ? other.submission.command.caller : undefined,
    });
    const result = retireTaskSubmissions(initial, cancellation("task-a"));
    expect(result.queue).toEqual([other]);
    expect(result.inputs).toEqual([]);
    expect(result.caller).toBe(initial.caller);
    expect(result.deliveries).toEqual({ queued: "retired", input: "retired", cancel: "applied" });
  });

  it("does not let a stale turn target purge queued task work", () => {
    const queued = message("queued", "task-a");
    const result = retireTaskSubmissions(
      checkpoint({ queue: [queued] }),
      cancellation("task-a", "old-turn"),
    );
    expect(result.queue).toEqual([queued]);
    expect(result.deliveries).toEqual({ cancel: "retired" });
  });

  it("purges all same-batch work even when a mixed message's response was split for admission", () => {
    const original = message("mixed", "task-a");
    const mixed: PendingSubmission = {
      ...original,
      submission: {
        ...original.submission,
        command: {
          ...original.submission.command,
          kind: "send",
          payload: { message: "Next", inputResponses: [{ requestId: "question", text: "Yes" }] },
        },
      },
    };
    const cancel = { candidateRunId: "canceller", submission: cancellation("task-a") };
    const other = message("other", "task-b");
    const result = admitSubmissions(checkpoint(), [cancel, mixed, other]);
    expect(result.queue).toEqual([other]);
    expect(result.inputs).toEqual([]);
    expect(result.deliveries).toEqual({
      "mixed:response": "retired",
      mixed: "retired",
      cancel: "applied",
    });
  });

  it("accounts for task cancellation during another caller's natural settlement", () => {
    const queued = message("queued", "task-a");
    const other = message("other", "task-b");
    const result = accountPending(
      checkpoint({ queue: [queued, other] }),
      [
        {
          eventId: "cancel",
          kind: "session.submit",
          payload: { candidateRunId: "canceller", submission: cancellation("task-a") },
        },
      ],
      "natural",
    );
    expect(result.queue).toEqual([other]);
    expect(result.deliveries).toEqual({ queued: "retired", cancel: "applied" });
  });
  it("does not reapply a duplicate task cancellation to later admitted work", () => {
    const queued = message("later", "task-a");
    const initial = checkpoint({ deliveries: { cancel: "applied" }, queue: [queued] });
    const result = admitSubmissions(initial, [
      { candidateRunId: "duplicate", submission: cancellation("task-a") },
    ]);
    expect(result.queue).toEqual([queued]);
    expect(result.deliveries).toEqual({ cancel: "applied" });
  });

  it("does not treat the previous snapshot writer as an active turn after settlement", () => {
    const queued = message("queued", "task-a");
    const result = retireTaskSubmissions(
      checkpoint({ phase: "settled", queue: [queued] }),
      cancellation("task-a", "turn_owner"),
    );
    expect(result.queue).toEqual([queued]);
    expect(result.deliveries).toEqual({ cancel: "retired" });
  });
});
