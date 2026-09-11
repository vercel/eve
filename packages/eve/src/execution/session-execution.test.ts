import { createTestSessionState } from "#internal/testing/session-state.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import { SessionExecution } from "#execution/session-execution.js";
import { SessionExecutionCursor } from "#execution/session-execution-cursor.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { turnStep, settleTurnStep } from "#execution/workflow-steps.js";
import type { DeliverHookPayload } from "#channel/types.js";

vi.mock("#execution/workflow-steps.js", () => ({
  turnStep: vi.fn(),
  settleTurnStep: vi.fn(),
}));
vi.mock("#execution/tasks/parent/delegate.js", () => ({
  acknowledgeDelegatedTasksStep: vi.fn(),
}));
vi.mock("#execution/cancel-descendant-turns-step.js", () => ({
  cancelDescendantTurnsStep: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe("SessionExecution background task checkpoints", () => {
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
    const bufferedDeliveries: DeliverHookPayload[] = [];
    const inbox: SessionInbox = {
      claimSessionHook: vi.fn(),
      consumeNext: vi.fn(),
      drain: vi.fn().mockReturnValueOnce([background, steering]).mockReturnValue([]),
      hasPending: vi.fn(async () => false),
      hasReadyAuthorization: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      restore: vi.fn(),
      sessionHookTokens: [],
      setAuthorizationWindow: vi.fn(),
    };
    const execution = new SessionExecution({
      bufferedDeliveries,
      bufferedSessionControls: [],
      cancelledTaskIds: new Set(),
      commandInbox: inbox,
      mode: "conversation",
      parentWritable: new WritableStream<Uint8Array>(),
      seenTaskDeliveries: new Set(),
      serializedContext: {},
      sessionState: state(""),
    });
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
    expect(bufferedDeliveries).toEqual([background]);
  });

  it.each(["cancelled", "done"] as const)(
    "retains task observability when a %s step races cancellation",
    async (action) => {
      vi.mocked(settleTurnStep).mockClear();
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
        hasPending: vi.fn(async () => false),
        hasReadyAuthorization: vi.fn(() => false),
        next: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: { kind: "cancel" } })
          .mockImplementation(() => new Promise(() => {})),
        restore: vi.fn(),
        sessionHookTokens: [],
        setAuthorizationWindow: vi.fn(),
      };
      const execution = new SessionExecution({
        bufferedDeliveries: [],
        bufferedSessionControls: [],
        cancelledTaskIds: new Set(),
        commandInbox: inbox,
        mode: "conversation",
        parentWritable: new WritableStream<Uint8Array>(),
        seenTaskDeliveries: new Set(),
        serializedContext: { state: "before" },
        sessionState: initialState,
      });
      const adopt = vi.spyOn(SessionExecutionCursor.prototype, "adopt");
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
      expect(settleTurnStep).not.toHaveBeenCalled();
    },
  );
});

function state(continuationToken: string): DurableSessionState {
  return createTestSessionState({
    continuationToken,
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
    hasProxyInputRequests: false,
    sessionId: "session-1",
    version: 1,
  });
}
