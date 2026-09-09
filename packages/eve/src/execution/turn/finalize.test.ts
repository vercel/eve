import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeTurnStep,
  failTurnStep,
  commitTurnStep,
  closeSessionStep,
} from "#execution/turn/finalize.js";
import { createSessionResources } from "#execution/session/resources.js";
import type { InitializedSessionCheckpoint } from "#execution/turn/types.js";
import { createDurableSessionState } from "#execution/session/state.js";
import { createSessionWaitingEvent, stampMessageStreamEvent } from "#protocol/message.js";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  latest: vi.fn(),
  close: vi.fn(),
  events: vi.fn(),
  closeEvents: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
  cancelDescendants: vi.fn(),
  terminate: vi.fn(),
  notify: vi.fn(),
  notifyCancel: vi.fn(),
  cancelRun: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ stepId: "finalize" }),
  getWorkflowMetadata: () => ({ workflowRunId: "owner" }),
}));
vi.mock("#execution/session/snapshots.js", () => ({
  sessionSnapshots: { append: mocks.append, latest: mocks.latest, close: mocks.close },
}));
vi.mock("#execution/session/events.js", () => ({
  sessionEvents: {
    append: mocks.events,
    close: mocks.closeEvents,
    withWriter: async (_: unknown, run: (writer: WritableStream<Uint8Array>) => Promise<unknown>) =>
      run(new WritableStream()),
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
  terminateChildSessions: mocks.terminate,
}));
vi.mock("#execution/session-timeout-steps.js", () => ({ cancelSessionTimeout: vi.fn() }));
vi.mock("#subagents/parent-notification.js", () => ({
  notifyTurnCaller: mocks.notify,
  notifyCancelledTaskCaller: mocks.notifyCancel,
  notifyDelegatedParent: vi.fn(),
}));
vi.mock("#subagents/callbacks.js", () => ({ fireSessionCallback: vi.fn() }));
vi.mock("#execution/turn/initialization-failure.js", () => ({
  notifyInitializationFailure: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: mocks.cancelRun,
  getWorld: async () => ({}),
}));
vi.mock("#internal/logging.js", () => ({ createLogger: () => ({ error: vi.fn() }) }));

const session = createSessionResources("holder", "initial");
let checkpoint: InitializedSessionCheckpoint;
beforeEach(() => {
  vi.resetAllMocks();
  const state = createDurableSessionState({
    session: {
      sessionId: "holder",
      continuationToken: "alias",
      history: [],
      agent: { modelReference: { id: "model" }, system: "", tools: [] },
      compaction: { threshold: 1000, recentWindowSize: 10 },
    },
  });
  checkpoint = {
    writeId: "model",
    writerRunId: "owner",
    phase: "running",
    state,
    serializedContext: { "eve.mode": "conversation" },
    deliveries: { initial: "applied", older: "applied" },
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
  const settled = async (input: { sessionState: unknown; serializedContext: unknown }) => ({
    sessionState: input.sessionState,
    serializedContext: input.serializedContext,
  });
  mocks.finalize.mockImplementation(settled);
  mocks.cancel.mockImplementation(settled);
  mocks.latest.mockResolvedValue(null);
});

const finalize = (overrides: Partial<Parameters<typeof finalizeTurnStep>[0]> = {}) =>
  finalizeTurnStep({
    session,
    checkpoint,
    eventIds: ["initial"],
    kind: "natural",
    pending: [],
    ...overrides,
  });

describe("turn settlement", () => {
  it("finalizes supplied state with no snapshot I/O, then commits one full record", async () => {
    const settled = await finalize();
    expect(settled.phase).toBe("settled");
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    const receipt = await commitTurnStep({ session, checkpoint: settled, eventIds: ["initial"] });
    expect(mocks.append).toHaveBeenCalledExactlyOnceWith(session.snapshots, settled);
    expect(receipt).toEqual({
      terminal: false,
      deliveries: { initial: "applied" },
      continuationToken: "alias",
    });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("preserves queued candidate identities and pending callers", async () => {
    const item = {
      candidateRunId: "waiting",
      submission: {
        eventId: "next",
        acceptedDeploymentId: "deployment",
        command: { kind: "send" as const, payload: { message: "Next" } },
      },
    };
    const settled = await finalize({
      pending: [{ eventId: "next", kind: "session.submit", payload: item }],
    });
    expect(settled).toMatchObject({
      queue: [item],
      caller: checkpoint.caller,
      deliveries: checkpoint.deliveries,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("retains lifecycle-induced state for the final commit", async () => {
    mocks.finalize.mockResolvedValue({
      sessionState: { ...checkpoint.state, continuationToken: "new-alias" },
      serializedContext: { changed: true },
    });
    expect(await finalize({ claimedContinuationToken: "old-alias" })).toMatchObject({
      state: { continuationToken: "new-alias" },
      serializedContext: { changed: true },
      claimedContinuationToken: "old-alias",
    });
  });

  it("uses cancellation carveouts when an interrupt overtakes model completion", async () => {
    const cancellationState = { ...checkpoint.state, continuationToken: "retained" };
    checkpoint = {
      ...checkpoint,
      result: { ...checkpoint.result!, cancellationState, cancellationContext: { retained: true } },
    };
    await finalize({ kind: "interrupt" });
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionState: cancellationState,
        serializedContext: { retained: true },
        settlement: expect.objectContaining({ events: [{ type: "turn.interrupted" }] }),
      }),
    );
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.notifyCancel).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "parked" }),
    );
  });

  it("retries a failed append without repeating completed lifecycle work", async () => {
    const settled = await finalize();
    mocks.append.mockRejectedValueOnce(new Error("Write failed"));
    const input = { session, checkpoint: settled, eventIds: ["initial"] };
    await expect(commitTurnStep(input)).rejects.toThrow("Write failed");
    await commitTurnStep(input);
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.append.mock.calls[0]).toEqual(mocks.append.mock.calls[1]);
  });

  it("allows normal Workflow retries of interrupted lifecycle work", async () => {
    mocks.finalize.mockRejectedValueOnce(new Error("Transient failure"));
    await expect(finalize()).rejects.toThrow("Transient failure");
    await finalize();
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("commits terminal state before closing shared streams and the holder", async () => {
    const settled = await finalize({ kind: "reset" });
    expect(settled.phase).toBe("terminal");
    expect(mocks.close).not.toHaveBeenCalled();
    await commitTurnStep({ session, checkpoint: settled, eventIds: ["initial"] });
    await closeSessionStep(session, settled);
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.close.mock.invocationCallOrder[0]!,
    );
    expect(mocks.cancelRun).toHaveBeenCalled();
  });

  it("does not mistake unavailable storage for uninitialized state", async () => {
    mocks.latest.mockRejectedValue(new Error("Storage unavailable"));
    await expect(
      failTurnStep({
        session,
        eventIds: ["initial"],
        submission: { eventId: "initial", command: { kind: "cancel" } },
        error: "failed",
      }),
    ).rejects.toThrow("Storage unavailable");
    expect(mocks.events).not.toHaveBeenCalled();
  });

  it("returns initialization failure state without an intermediate snapshot write", async () => {
    const failed = await failTurnStep({
      session,
      eventIds: ["initial"],
      submission: { eventId: "initial", command: { kind: "cancel" } },
      error: "private details",
    });
    expect(failed).toMatchObject({
      phase: "initialization-failed",
      deliveries: { initial: "retired" },
    });
    expect(failed).not.toHaveProperty("state");
    expect(mocks.append).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.events.mock.calls)).not.toContain("private details");
  });
});
