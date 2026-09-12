import { createTestSessionState } from "#internal/testing/session-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { SessionBacklog } from "#execution/session-backlog.js";
import { SessionExecution } from "#execution/session-execution.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { turnStep, commitSettlementStep } from "#execution/workflow-steps.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://parent.example" }),
}));
vi.mock("#execution/coordination-dispatch-step.js", () => ({ dispatchCoordinationStep: vi.fn() }));

vi.mock("#execution/workflow-steps.js", () => ({
  turnStep: vi.fn(),
  commitSettlementStep: vi.fn(),
}));
vi.mock("#execution/tasks/parent/delegate.js", () => ({
  acknowledgeDelegatedTasksStep: vi.fn(),
}));
vi.mock("#execution/cancel-descendant-turns-step.js", () => ({
  cancelDescendantTurnsStep: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe("SessionExecution background task checkpoints", () => {
  it("cancels an admitted workflow action when cancellation already arrived at the step boundary", async () => {
    const sessionState = state("");
    const inbox: SessionInbox = {
      claimSessionHook: vi.fn(),
      consumeNext: vi.fn(),
      drain: vi
        .fn()
        .mockReturnValueOnce([{ kind: "cancel" }])
        .mockReturnValue([]),
      hasPending: vi.fn(() => false),
      hasReadyAuthorization: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      restore: vi.fn(),
      sessionHookTokens: ["parent-inbox"],
      setAuthorizationWindow: vi.fn(),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep)
      .mockReset()
      .mockResolvedValue({
        action: "park",
        pendingCoordinationCallIds: ["hold-call"],
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        serializedContext: {},
        sessionState,
      });
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      results: [],
      pendingTasks: [],
      sessionState,
    });

    await expect(
      execution.runTurn({ kind: "deliver", payloads: [{ message: "Start Alice's deployment" }] }),
    ).resolves.toMatchObject({ cancelled: true, kind: "park" });
    expect(dispatchCoordinationStep).toHaveBeenCalledTimes(1);
    expect(inbox.next).not.toHaveBeenCalledWith("runtime");
    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({ serializedContext: {}, sessionState });
  });

  it("retains background notifications for parked cohort routing while admitting user steering", async () => {
    const background: DeliverHookPayload = {
      kind: "deliver",
      taskDeliveryId: "task-1:completed",
      payloads: [{ message: "Background task task-1 is completed." }],
    };
    const steering: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Include Alice's update." }],
    };
    const backlog = new SessionBacklog();
    const inbox: SessionInbox = {
      claimSessionHook: vi.fn(),
      consumeNext: vi.fn(),
      drain: vi.fn().mockReturnValueOnce([background, steering]).mockReturnValue([]),
      hasPending: vi.fn(() => false),
      hasReadyAuthorization: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      restore: vi.fn(),
      sessionHookTokens: [],
      setAuthorizationWindow: vi.fn(),
    };
    const execution = createExecution({ backlog, inbox, sessionState: state("") });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(async (input) => ({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      }));

    await execution.runTurn({ kind: "deliver", payloads: [{ message: "Start the work." }] });

    expect(turnStep).toHaveBeenCalledTimes(2);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual(steering);
    expect(backlog.deliveries).toEqual([background]);
  });

  it.each(["cancelled", "done"] as const)(
    "retains task observability when a %s step races cancellation",
    async (action) => {
      vi.mocked(commitSettlementStep).mockClear();
      const initialState = state("");
      const backgroundState = state("http:background");
      const completedState = state("http:completed");
      const tasks = [
        { callId: "call-1", taskId: "task-1", taskInboxToken: "inbox-1", taskRunId: "run-1" },
      ];
      const observability = {
        "eve.harness.agentTrace": { actions: { "action-1": {} }, sessions: {}, turns: {} },
        "eve.harness.instrumentationActionScopes": {
          "action-1": { scope: { turnId: "turn_0" }, taskId: "task-1" },
        },
        "eve.harness.instrumentationState": { "sink\0action-1": { value: "open" } },
      };
      const backgroundContext = { ...observability, state: "before" };
      const completedContext = { ...observability, state: "completed" };
      const inbox: SessionInbox = {
        claimSessionHook: vi.fn(),
        consumeNext: vi.fn(),
        drain: vi.fn(() => []),
        hasPending: vi.fn(() => false),
        hasReadyAuthorization: vi.fn(() => false),
        next: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: { kind: "cancel" } })
          .mockImplementation(() => new Promise(() => {})),
        restore: vi.fn(),
        sessionHookTokens: [],
        setAuthorizationWindow: vi.fn(),
      };
      const execution = createExecution({
        inbox,
        serializedContext: { state: "before" },
        sessionState: initialState,
      });
      const adopt = vi.spyOn(SessionStateCursor.prototype, "adopt");
      vi.mocked(acknowledgeDelegatedTasksStep).mockImplementation(async () => {
        expect(execution.cursor.serializedContext).toEqual(backgroundContext);
        expect(execution.cursor.sessionState).toBe(backgroundState);
      });
      vi.mocked(turnStep).mockImplementationOnce(async (input) => {
        await vi.waitFor(() => expect(input.abortSignal?.aborted).toBe(true));
        return {
          action,
          backgroundTaskContext: backgroundContext,
          backgroundTaskState: backgroundState,
          backgroundTasks: tasks,
          serializedContext: completedContext,
          sessionState: completedState,
        };
      });

      const result = await execution.runTurn({
        kind: "deliver",
        payloads: [{ message: "work" }],
      });
      expect(result).toEqual({
        cancelled: true,
        kind: "park",
        serializedContext: completedContext,
        sessionState: backgroundState,
      });
      expect(adopt.mock.calls[0]?.[0]).toEqual({
        serializedContext: backgroundContext,
        sessionState: backgroundState,
      });
      expect(acknowledgeDelegatedTasksStep).toHaveBeenCalledWith({ tasks });
      expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
        serializedContext: completedContext,
        sessionState: backgroundState,
      });
      expect(commitSettlementStep).not.toHaveBeenCalled();
    },
  );
});

function createExecution(input: {
  readonly backlog?: SessionBacklog;
  readonly inbox: SessionInbox;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): SessionExecution {
  return new SessionExecution({
    backlog: input.backlog ?? new SessionBacklog(),
    commandInbox: input.inbox,
    cursor: new SessionStateCursor({
      commandInbox: input.inbox,
      parentWritable: new WritableStream<Uint8Array>(),
      serializedContext: input.serializedContext ?? {},
      sessionState: input.sessionState,
    }),
    mode: "conversation",
  });
}

function state(continuationToken: string): DurableSessionState {
  return createTestSessionState({
    continuationToken,
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
    hasProxyInputRequests: false,
    sessionId: "session-1",
    version: 1,
  });
}
