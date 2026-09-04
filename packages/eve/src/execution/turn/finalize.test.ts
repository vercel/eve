import { accountPending } from "#execution/turn/submissions.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { failTurnStep, finalizeTurnStep } from "#execution/turn/finalize.js";
import { createSessionResources, type SnapshotRecordRef } from "#execution/session/resources.js";
import type { InitializedSessionCheckpoint, SessionCheckpoint } from "#execution/turn/types.js";
import { createDurableSessionState } from "#execution/session/state.js";
import { createSessionWaitingEvent, stampMessageStreamEvent } from "#protocol/message.js";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  read: vi.fn(),
  append: vi.fn(),
  latest: vi.fn(),
  closeSnapshots: vi.fn(),
  appendEvents: vi.fn(),
  closeEvents: vi.fn(),
  publish: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
  cancelDescendants: vi.fn(),
  terminateChildren: vi.fn(),
  cancelTimer: vi.fn(),
  notifyCancel: vi.fn(),
  notifyCaller: vi.fn(),
  notifyParent: vi.fn(),
  callback: vi.fn(),
  cancelRun: vi.fn(),
  log: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ stepId: "commit" }),
  getWorkflowMetadata: () => ({ workflowRunId: "owner" }),
}));
vi.mock("#internal/logging.js", () => ({ createLogger: () => ({ error: mocks.log }) }));
vi.mock("#execution/turn/initialization-failure.js", () => ({
  notifyInitializationFailure: vi.fn(),
}));
vi.mock("#execution/session/snapshots.js", () => ({
  sessionSnapshots: {
    find: mocks.find,
    read: mocks.read,
    append: mocks.append,
    latest: mocks.latest,
    close: mocks.closeSnapshots,
  },
}));
vi.mock("#execution/session/events.js", () => ({
  sessionEvents: {
    append: mocks.appendEvents,
    close: mocks.closeEvents,
    withWriter: async (
      _ref: unknown,
      callback: (writable: WritableStream<Uint8Array>) => Promise<unknown>,
    ) => callback(new WritableStream()),
  },
}));
vi.mock("#execution/session/directory.js", () => ({ publishSessionDescriptor: mocks.publish }));
vi.mock("#execution/turn/finalize-model.js", () => ({ finalizeModelSettlement: mocks.finalize }));
vi.mock("#execution/turn/cancel.js", () => ({
  cancellationSettlement: (state: InitializedSessionCheckpoint["state"], kind: string) => ({
    events: [{ type: kind === "interrupt" ? "turn.interrupted" : "turn.cancelled" }],
    emissionAfter: state.emissionState,
  }),
  settleCancelledTurn: mocks.cancel,
}));
vi.mock("#execution/turn/cancel-descendants.js", () => ({
  cancelDescendantTurns: mocks.cancelDescendants,
}));
vi.mock("#execution/turn/terminate-children.js", () => ({
  terminateChildSessions: mocks.terminateChildren,
}));
vi.mock("#execution/session-timeout-steps.js", () => ({
  cancelSessionTimeout: mocks.cancelTimer,
}));
vi.mock("#subagents/parent-notification.js", () => ({
  notifyCancelledTaskCaller: mocks.notifyCancel,
  notifyTurnCaller: mocks.notifyCaller,
  notifyDelegatedParent: mocks.notifyParent,
}));
vi.mock("#subagents/parent-result.js", () => ({
  createDelegatedSubagentErrorResult: vi.fn(),
  createDelegatedSubagentSuccessResult: vi.fn(),
}));
vi.mock("#subagents/callbacks.js", () => ({ fireSessionCallback: mocks.callback }));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: mocks.cancelRun,
  getWorld: async () => ({}),
}));
vi.mock("#execution/tasks/workflow-target.js", () => ({ isTaskWorkflowTargetGone: () => false }));

const resources = createSessionResources("holder", "initial");
const records = new Map<string, SessionCheckpoint>();
let current: SessionCheckpoint | undefined;
const recordRef = (id: string) => ({ id }) as SnapshotRecordRef;

function checkpoint(): InitializedSessionCheckpoint {
  const state = createDurableSessionState({
    session: {
      sessionId: resources.sessionId,
      continuationToken: "alias",
      history: [],
      agent: { modelReference: { id: "model" }, system: "", tools: [] },
      compaction: { threshold: 1000, recentWindowSize: 10 },
    },
  });
  return {
    writeId: "proposal",
    writerRunId: "owner",
    phase: "running",
    state,
    serializedContext: { "eve.mode": "conversation" },
    deliveries: { initial: "applied" },
    queue: [],
    caller: {
      callId: "call",
      subagentName: "child",
      replyTo: { kind: "session", token: "parent" },
    },
    result: {
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: true,
      sessionState: state,
      serializedContext: {},
      settlement: {
        events: [stampMessageStreamEvent(createSessionWaitingEvent())],
        emissionAfter: state.emissionState,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  records.clear();
  current = checkpoint();
  records.set(current.writeId, current);
  mocks.find.mockImplementation(async (_ref, id: string) => {
    const stored = records.get(id);
    return stored === undefined ? undefined : { ref: recordRef(id), checkpoint: stored };
  });
  mocks.read.mockImplementation(async (ref: SnapshotRecordRef) => records.get(ref.id));
  mocks.latest.mockImplementation(async () =>
    current === undefined ? undefined : { ref: recordRef(current.writeId), checkpoint: current },
  );
  mocks.append.mockImplementation(async (_stream, value: SessionCheckpoint) => {
    records.set(value.writeId, value);
    current = value;
    return recordRef(value.writeId);
  });
  mocks.finalize.mockImplementation(async (input) => ({
    sessionState: input.sessionState,
    serializedContext: input.serializedContext,
  }));
  mocks.cancel.mockImplementation(async (input) => ({
    sessionState: input.sessionState,
    serializedContext: input.serializedContext,
  }));
  mocks.appendEvents.mockResolvedValue(undefined);
});

describe("turn finalization", () => {
  it("keeps a caller parked on HITL and preserves the accepting candidate of queued input", async () => {
    const original = current as InitializedSessionCheckpoint;
    records.set("proposal", {
      ...original,
      deliveries: { ...original.deliveries, "older-turn": "applied" },
    });
    const pending = {
      submission: {
        eventId: "followup",
        acceptedDeploymentId: "new-deployment",
        command: { kind: "send" as const, payload: { message: "Next" } },
      },
      candidateRunId: "waiting-candidate",
    };
    const result = await finalizeTurnStep({
      session: resources,
      eventIds: ["initial", "followup"],
      checkpoint: recordRef("proposal"),
      kind: "natural",
      pending: [{ kind: "session.submit", eventId: "delivery", payload: pending }],
    });
    expect(result.terminal).toBe(false);
    expect(result.deliveries).not.toHaveProperty("older-turn");
    const committed = records.get("commit") as InitializedSessionCheckpoint;
    expect(committed.caller).toEqual(original.caller);
    expect(committed.queue).toEqual([pending]);
    expect(committed.deliveries["older-turn"]).toBe("applied");
    expect(committed.claimedContinuationToken).toBeUndefined();
    expect(mocks.notifyCaller).not.toHaveBeenCalled();
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finalize.mock.invocationCallOrder[0]!,
    );
  });

  it("returns the continuation token committed by terminal lifecycle hooks before ownership releases", async () => {
    mocks.finalize.mockImplementationOnce(async (input) => ({
      serializedContext: input.serializedContext,
      sessionState: {
        ...input.sessionState,
        continuationToken: "new-alias",
        snapshot: {
          session: { ...input.sessionState.snapshot.session, continuationToken: "new-alias" },
        },
      },
    }));
    const result = await finalizeTurnStep({
      session: resources,
      eventIds: ["initial", "followup"],
      claimedContinuationToken: "acknowledged-alias",
      checkpoint: recordRef("proposal"),
      kind: "natural",
      pending: [],
    });
    expect(result).toMatchObject({ terminal: false, continuationToken: "new-alias" });
    expect((records.get("commit") as InitializedSessionCheckpoint).claimedContinuationToken).toBe(
      "acknowledged-alias",
    );
  });

  it("preserves a previously acknowledged alias when no new acknowledgment is supplied", async () => {
    current = {
      ...current,
      claimedContinuationToken: "known-alias",
    } as InitializedSessionCheckpoint;
    records.set("proposal", current);
    await finalizeTurnStep({
      session: resources,
      eventIds: ["initial", "followup"],
      checkpoint: recordRef("proposal"),
      kind: "natural",
      pending: [],
    });
    expect((records.get("commit") as InitializedSessionCheckpoint).claimedContinuationToken).toBe(
      "known-alias",
    );
  });

  it("publishes a completed outcome once and skips authored effects on a committed retry", async () => {
    const original = current as InitializedSessionCheckpoint;
    current = {
      ...original,
      result: {
        action: "done",
        output: "Answer",
        sessionState: original.state,
        serializedContext: {},
        settlement: original.result?.settlement,
      },
    };
    records.set("proposal", current);
    const input = {
      session: resources,
      eventIds: ["initial", "followup"],
      checkpoint: recordRef("proposal"),
      kind: "natural" as const,
      pending: [],
    };
    const first = await finalizeTurnStep(input);
    expect(first.terminal).toBe(true);
    expect(mocks.notifyCaller).toHaveBeenCalledTimes(1);
    expect(await finalizeTurnStep(input)).toEqual(first);
    expect(mocks.finalize).toHaveBeenCalledTimes(1);
    expect(mocks.notifyCaller).toHaveBeenCalledTimes(1);
    expect((records.get("commit") as InitializedSessionCheckpoint).caller).toBeUndefined();
  });

  it("uses the cancellation carveouts when an interrupt overtakes a completed model call", async () => {
    const original = current as InitializedSessionCheckpoint;
    const cancellationState = { ...original.state, continuationToken: "retained" };
    const cancellationContext = { retained: true };
    current = {
      ...original,
      result: { ...original.result!, cancellationState, cancellationContext },
    };
    records.set("proposal", current);
    await finalizeTurnStep({
      session: resources,
      eventIds: ["initial", "followup"],
      checkpoint: recordRef("proposal"),
      kind: "interrupt",
      pending: [],
    });
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionState: cancellationState,
        serializedContext: cancellationContext,
        settlement: expect.objectContaining({ events: [{ type: "turn.interrupted" }] }),
      }),
    );
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.notifyCancel).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "parked" }),
    );
  });

  it("does not repeat terminal effects after an uncommitted finalization attempt", async () => {
    mocks.finalize.mockRejectedValueOnce(new Error("Lost completion"));
    const input = {
      session: resources,
      eventIds: ["initial", "followup"],
      checkpoint: recordRef("proposal"),
      kind: "natural" as const,
      pending: [],
    };
    await expect(finalizeTurnStep(input)).rejects.toThrow("Lost completion");
    await expect(finalizeTurnStep(input)).rejects.toThrow("did not commit its effects");
    expect(mocks.finalize).toHaveBeenCalledTimes(1);
  });

  it("does not confuse unreadable state with an empty session", async () => {
    mocks.latest.mockRejectedValueOnce(new Error("Storage failed"));
    await expect(
      failTurnStep({
        session: resources,
        eventIds: ["initial", "followup"],
        submission: { eventId: "initial", command: { kind: "cancel" } },
        error: "private failure",
      }),
    ).rejects.toThrow("Storage failed");
    expect(mocks.appendEvents).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("records initialization failure without inventing a harness snapshot or exposing the error", async () => {
    records.clear();
    current = undefined;
    const input = {
      session: resources,
      eventIds: ["initial", "followup"],
      submission: { eventId: "initial", command: { kind: "cancel" as const } },
      error: "private secret detail",
    };
    const result = await failTurnStep(input);
    expect(result).toMatchObject({ terminal: true, deliveries: { initial: "retired" } });
    const failed = records.get("commit");
    expect(failed?.phase).toBe("initialization-failed");
    expect(failed).not.toHaveProperty("state");
    expect(JSON.stringify(mocks.appendEvents.mock.calls)).not.toContain("private secret detail");
    expect(mocks.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: "private secret detail" }),
    );
    await failTurnStep(input);
    expect(mocks.appendEvents).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an uncertain bootstrap failure notification", async () => {
    mocks.latest.mockResolvedValue(undefined);
    mocks.appendEvents.mockRejectedValueOnce(new Error("Write completion unknown"));
    const input = {
      session: resources,
      eventIds: ["initial", "followup"],
      submission: {
        eventId: "initial",
        command: { kind: "send" as const, payload: { message: "Hello" } },
      },
      error: "private",
    };
    await expect(failTurnStep(input)).rejects.toThrow("Write completion unknown");
    await expect(failTurnStep(input)).rejects.toThrow("did not commit its effects");
    expect(mocks.appendEvents).toHaveBeenCalledOnce();
  });
  it("accounts for a cancellation request while retaining undispatched input", () => {
    const original = checkpoint();
    const message = {
      candidateRunId: "candidate",
      submission: {
        eventId: "steer",
        command: { kind: "send" as const, payload: { message: "Keep me" } },
      },
    };
    const cancel = {
      candidateRunId: "cancel-candidate",
      submission: { eventId: "cancel", command: { kind: "cancel" as const } },
    };
    const accounted = accountPending({ ...original, inputs: [message, cancel] }, [], "cancel");
    expect(accounted.queue).toEqual([message]);
    expect(accounted.deliveries.cancel).toBe("applied");
    expect(accounted.inputs).toEqual([]);
  });
});
