import { describe, expect, it } from "vitest";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import type { SnapshotRecordRef } from "#execution/session/resources.js";
import type { AcceptedSubmission, TurnProgress } from "#execution/turn/types.js";
import { interruptionKind, reduceTurnBoundary } from "#execution/turn/reduce.js";

const progress: TurnProgress = {
  checkpoint: { id: "checkpoint" } as SnapshotRecordRef,
  turnId: "active-turn",
  action: "settle",
  terminal: false,
  continuationToken: "token",
};
function submission(command: AcceptedSubmission["command"]): AcceptedSubmission {
  return { eventId: "event", command };
}
function envelope(command: AcceptedSubmission["command"]): InboxEnvelope {
  return {
    eventId: "event",
    kind: "session.submit",
    payload: { submission: submission(command), candidateRunId: "candidate" },
  };
}

describe("turn boundary decisions", () => {
  it("guards targeted cancellation against the logical turn", () => {
    expect(
      interruptionKind(submission({ kind: "cancel", turnId: "earlier-turn" }), progress.turnId),
    ).toBeUndefined();
    expect(
      interruptionKind(submission({ kind: "cancel", turnId: "active-turn" }), progress.turnId),
    ).toBe("cancel");
    expect(interruptionKind(submission({ kind: "cancel" }), progress.turnId)).toBe("cancel");
  });
  it("prioritizes reset and timeout over cancellation and replacement", () => {
    const controls = [
      envelope({ kind: "cancel" }),
      envelope({ kind: "send", turnPolicy: "interrupt", payload: { message: "replace" } }),
      envelope({ kind: "session-timeout" }),
    ];
    expect(reduceTurnBoundary(progress, controls)).toEqual({
      kind: "finalize",
      settlement: "timeout",
    });
    expect(reduceTurnBoundary(progress, [...controls, envelope({ kind: "reset" })])).toEqual({
      kind: "finalize",
      settlement: "reset",
    });
  });
  it("settles queue-only messages so their candidate can claim the next turn", () => {
    expect(
      reduceTurnBoundary(progress, [
        envelope({ kind: "send", turnPolicy: "queue", payload: { message: "later" } }),
      ]),
    ).toEqual({ kind: "finalize", settlement: "natural" });
  });
  it("routes an input response immediately even when its accompanying message is queued", () => {
    const event = envelope({
      kind: "send",
      turnPolicy: "queue",
      payload: { message: "later", inputResponses: [{ requestId: "question", text: "yes" }] },
    });
    expect(reduceTurnBoundary({ ...progress, action: "wait" }, [event])).toEqual({
      kind: "events",
    });
  });
  it("keeps steering buffered while runtime work is pending", () => {
    const steer = envelope({ kind: "send", payload: { message: "steer" } });
    expect(reduceTurnBoundary({ ...progress, action: "wait" }, [steer])).toEqual({
      kind: "events",
    });
    expect(reduceTurnBoundary({ ...progress, action: "dispatch" }, [steer])).toEqual({
      kind: "dispatch",
    });
    expect(reduceTurnBoundary(progress, [steer])).toEqual({ kind: "model" });
    expect(reduceTurnBoundary({ ...progress, terminal: true }, [steer])).toEqual({
      kind: "finalize",
      settlement: "natural",
    });
  });
  it("does not treat an answer-only interrupt policy as cancellation", () => {
    const command = {
      kind: "send" as const,
      turnPolicy: "interrupt" as const,
      payload: { inputResponses: [{ requestId: "question", text: "yes" }] },
    };
    expect(interruptionKind(submission(command), progress.turnId)).toBeUndefined();
    expect(reduceTurnBoundary({ ...progress, action: "wait" }, [envelope(command)])).toEqual({
      kind: "events",
    });
  });
  it("purges a queued task cancellation without aborting another task's active turn", () => {
    const cancellation = { kind: "cancel" as const, taskId: "queued-task" };
    expect(
      interruptionKind(submission(cancellation), progress.turnId, "active-task"),
    ).toBeUndefined();
    expect(interruptionKind(submission(cancellation), progress.turnId, "queued-task")).toBe(
      "cancel",
    );
    expect(
      reduceTurnBoundary({ ...progress, action: "wait", taskId: "active-task" }, [
        envelope(cancellation),
      ]),
    ).toEqual({ kind: "events" });
  });
});
