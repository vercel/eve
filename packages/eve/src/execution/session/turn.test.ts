import { createTestSessionState } from "#internal/testing/session-state.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionExecution } from "#execution/session/turn.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { turnStep } from "#execution/session/turn-step.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://parent.example" }),
}));
vi.mock("#execution/coordination-dispatch-step.js", () => ({ dispatchCoordinationStep: vi.fn() }));

vi.mock("#execution/session/turn-step.js", () => ({
  turnStep: vi.fn(),
}));
vi.mock("#execution/tasks/parent/delegate.js", () => ({
  acknowledgeDelegatedTasksStep: vi.fn(),
}));
vi.mock("#execution/cancel-descendant-turns-step.js", () => ({
  cancelDescendantTurnsStep: vi.fn(),
}));
vi.mock("#execution/route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(routeDeliverToChildren)
    .mockReset()
    .mockImplementation(async ({ delivery, serializedContext, sessionState }) => ({
      kind: "continue",
      remainder: delivery,
      serializedContext,
      sessionState,
    }));
});
afterEach(() => vi.restoreAllMocks());

describe("SessionExecution background task checkpoints", () => {
  it("cancels an admitted workflow action when cancellation already arrived at the step boundary", async () => {
    const sessionState = state("");
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi
        .fn()
        .mockReturnValueOnce([{ kind: "cancel" }])
        .mockReturnValue([]),
      hasPending: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
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
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start Alice's deployment" }] },
      }),
    ).resolves.toMatchObject({ cancelled: true, kind: "park" });
    expect(dispatchCoordinationStep).toHaveBeenCalledTimes(1);
    expect(inbox.next).not.toHaveBeenCalled();
    expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({ serializedContext: {}, sessionState });
  });

  it("steers a continuing turn with user input while retaining background notifications for cohort routing", async () => {
    const background: DeliverHookPayload = {
      kind: "deliver",
      taskDeliveryId: "task-1:completed",
      payloads: [{ message: "Background task task-1 is completed." }],
    };
    const steering: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Include Alice's update." }],
    };
    const queue = new SessionInputQueue();
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn().mockReturnValueOnce([background, steering]).mockReturnValue([]),
      hasPending: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, queue, sessionState: state("") });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(async (input) => ({
        action: "continue",
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      }))
      .mockImplementation(async (input) => ({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      }));

    await execution.runTurn({
      delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
    });

    expect(turnStep).toHaveBeenCalledTimes(2);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({ delivery: steering });
    expect(queue.pendingCount).toBe(1);
  });

  it("applies steering accepted during a blocking action before its result continues the turn", async () => {
    const sessionState = state("");
    const steering: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Include Alice's update." }],
    };
    const actionResult = {
      callId: "hold-call",
      kind: "tool-result" as const,
      output: { deployed: true },
      toolName: "deploy",
    };
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn().mockReturnValueOnce([steering]).mockReturnValue([]),
      hasPending: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep)
      .mockReset()
      .mockResolvedValueOnce({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        pendingCoordinationCallIds: ["hold-call"],
        serializedContext: {},
        sessionState,
      })
      .mockResolvedValueOnce({
        action: "done",
        output: "done",
        serializedContext: {},
        sessionState,
      });
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockResolvedValue({
        pendingTasks: [],
        results: [actionResult],
        sessionState,
      });

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toMatchObject({ kind: "done", output: "done" });

    // Steering and the blocking action's result travel in one step, steering first.
    expect(turnStep).toHaveBeenCalledTimes(2);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toMatchObject({
      delivery: steering,
      runtimeResults: { results: [actionResult] },
    });
    expect(dispatchCoordinationStep).toHaveBeenCalledTimes(1);
  });

  it("treats input that arrives after a settled turn as the next turn", async () => {
    const followUp: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "One more thing." }],
    };
    const queue = new SessionInputQueue();
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn().mockReturnValueOnce([followUp]).mockReturnValue([]),
      hasPending: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, queue, sessionState: state("") });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(async (input) => ({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
        settled: { output: "Done." },
      }));

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toMatchObject({ kind: "park", settled: { output: "Done." } });

    expect(turnStep).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount).toBe(1);
  });

  it("routes a task-owned answer to a descendant while waiting for runtime results", async () => {
    const sessionState = { ...state(""), hasProxyInputRequests: true };
    const taskAnswer: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "child-request", text: "blue" }] }],
      taskDeliveryId: "task-1:child-request",
    };
    const runtimePayloads = [taskAnswer, { kind: "cancel" as const }];
    const queue = new SessionInputQueue();
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      next: vi.fn(async () => runtimePayloads.shift()),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, queue, sessionState });
    vi.mocked(turnStep).mockResolvedValue({
      action: "park",
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      pendingCoordinationCallIds: ["child-call"],
      serializedContext: {},
      sessionState,
    });
    vi.mocked(dispatchCoordinationStep).mockResolvedValue({
      pendingTasks: [],
      results: [],
      sessionState,
    });
    vi.mocked(routeDeliverToChildren).mockResolvedValue({
      kind: "continue",
      remainder: undefined,
      serializedContext: {},
      sessionState: { ...sessionState, hasProxyInputRequests: false },
    });

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toEqual({ cancelled: true, kind: "park" });

    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: taskAnswer }),
    );
    expect(queue.pendingCount).toBe(0);
  });

  it.each(["cancelled", "done"] as const)(
    "retains task observability when a %s step races cancellation",
    async (action) => {
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
      let interrupt: ((payload: SessionInboxPayload) => void) | undefined;
      const inbox: SessionInbox = {
        claimedTokens: [],
        claimSessionHook: vi.fn(),
        claimSessionHooks: vi.fn(),
        drain: vi
          .fn()
          .mockReturnValueOnce([{ kind: "cancel" }])
          .mockReturnValue([]),
        hasPending: vi.fn(() => false),
        next: vi.fn(() => new Promise<never>(() => {})),
        onInterrupt: vi.fn((handler) => {
          interrupt = handler;
          return () => {};
        }),
        restore: vi.fn(),
      };
      const execution = createExecution({
        inbox,
        serializedContext: { state: "before" },
        sessionState: initialState,
      });
      const apply = vi.spyOn(SessionStateCursor.prototype, "apply");
      vi.mocked(acknowledgeDelegatedTasksStep).mockImplementation(async () => {
        expect(execution.cursor.serializedContext).toEqual(backgroundContext);
        expect(execution.cursor.sessionState).toBe(backgroundState);
      });
      vi.mocked(turnStep).mockImplementationOnce(async (input) => {
        // The pump pushes the accepted cancel while this step is still running.
        interrupt?.({ kind: "cancel" });
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
        delivery: { kind: "deliver", payloads: [{ message: "work" }] },
      });
      expect(result).toEqual({
        cancelled: true,
        kind: "park",
      });
      expect(apply.mock.calls[0]?.[0]).toEqual({
        serializedContext: backgroundContext,
        sessionState: backgroundState,
      });
      expect(acknowledgeDelegatedTasksStep).toHaveBeenCalledWith({ tasks });
      expect(cancelDescendantTurnsStep).toHaveBeenCalledWith({
        serializedContext: completedContext,
        sessionState: backgroundState,
      });
    },
  );
});

function createExecution(input: {
  readonly inbox: SessionInbox;
  readonly queue?: SessionInputQueue;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): SessionExecution {
  const cursor = new SessionStateCursor({
    inbox: input.inbox,
    parentWritable: new WritableStream<Uint8Array>(),
    serializedContext: input.serializedContext ?? {},
    sessionState: input.sessionState,
  });
  return new SessionExecution({
    cursor,
    inbox: input.inbox,
    mode: "conversation",
    queue: input.queue ?? new SessionInputQueue(),
    sessionId: input.sessionState.sessionId,
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
