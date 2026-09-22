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
  it("retains the durable steering signal across steps until a correction uses it", async () => {
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: () => [],
      hasPending: () => false,
      next: vi.fn(),
      restore: vi.fn(),
      onDelivery: () => () => {},
      onInterrupt: () => () => {},
    };
    let signal: AbortSignal | undefined;
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(async (input) => {
        signal = input.steeringSignal;
        return {
          action: "continue",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      })
      .mockImplementationOnce(async (input) => {
        expect(input.steeringSignal).toBe(signal);
        return {
          action: "done",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      });
    await createExecution({ inbox, sessionState: state("") }).runTurn(undefined);
    expect(turnStep).toHaveBeenCalledTimes(2);
  });
  it.each(["cancel", "reset"] as const)(
    "gives %s precedence over generation steering",
    async (kind) => {
      let deliver: (payload: SessionInboxPayload) => void = () => {};
      let interrupt: (payload: SessionInboxPayload) => void = () => {};
      const pending: SessionInboxPayload[] = [];
      const inbox: SessionInbox = {
        claimedTokens: [],
        claimSessionHook: vi.fn(),
        claimSessionHooks: vi.fn(),
        drain: () => pending.splice(0),
        hasPending: () => pending.length > 0,
        next: vi.fn(),
        restore: vi.fn(),
        onDelivery: (handler) => {
          deliver = handler;
          return () => {};
        },
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => {};
        },
      };
      vi.mocked(turnStep)
        .mockReset()
        .mockImplementationOnce(async (input) => {
          const correction = { kind: "deliver", payloads: [{ message: "Correction" }] } as const;
          pending.push(correction, { kind });
          deliver(correction);
          interrupt({ kind });
          expect(input.steeringSignal?.aborted).toBe(true);
          expect(input.abortSignal?.aborted).toBe(true);
          return {
            action: "steered",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        });
      await expect(
        createExecution({ inbox, sessionState: state("") }).runTurn(undefined),
      ).resolves.toEqual({ cancelled: true, kind: "park" });
      expect(turnStep).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps a correction pumped during boundary admission attached to the next step", async () => {
    let notify: (payload: SessionInboxPayload) => void = () => {};
    const pending: SessionInboxPayload[] = [];
    const first: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "First correction" }],
    };
    const second: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Second correction" }],
    };
    let drainingFirst = true;
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: () => {
        const snapshot = pending.splice(0);
        if (drainingFirst) {
          drainingFirst = false;
          queueMicrotask(() => {
            pending.push(second);
            notify(second);
          });
        }
        return snapshot;
      },
      hasPending: () => pending.length > 0,
      next: vi.fn(),
      restore: vi.fn(),
      onInterrupt: () => () => {},
      onDelivery: (handler) => {
        notify = handler;
        pending.forEach(handler);
        return () => {};
      },
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(async (input) => {
        pending.push(first);
        notify(first);
        return {
          action: "steered",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      })
      .mockImplementationOnce(async (input) => {
        expect(input.input?.delivery?.payloads).toEqual(first.payloads);
        expect(input.steeringSignal?.aborted).toBe(true);
        return {
          action: "steered",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      })
      .mockImplementationOnce(async (input) => {
        expect(input.input?.delivery?.payloads).toEqual(second.payloads);
        expect(input.steeringSignal?.aborted).toBe(false);
        return {
          action: "done",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      });
    await createExecution({ inbox, sessionState: state("") }).runTurn(undefined);
    expect(turnStep).toHaveBeenCalledTimes(3);
  });
  it("signals generation steering, coalesces corrections in order, and continues without cancellation", async () => {
    let notify: (payload: SessionInboxPayload) => void = () => {};
    const pending: SessionInboxPayload[] = [];
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: () => pending.splice(0),
      hasPending: () => pending.length > 0,
      next: vi.fn(),
      restore: vi.fn(),
      onInterrupt: () => () => {},
      onDelivery: (handler) => {
        notify = handler;
        return () => {};
      },
    };
    vi.mocked(cancelDescendantTurnsStep).mockClear();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(async (input) => {
        for (const message of ["Actually 2025", "Include the MVP"]) {
          const delivery = { kind: "deliver", payloads: [{ message }] } as const;
          pending.push(delivery);
          notify(delivery);
        }
        expect(input.steeringSignal?.aborted).toBe(true);
        expect(input.abortSignal?.aborted).toBe(false);
        return {
          action: "steered",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      })
      .mockImplementationOnce(async (input) => {
        expect(input.steeringSignal?.aborted).toBe(false);
        expect(input.input?.delivery?.payloads.map((payload) => payload.message)).toEqual([
          "Actually 2025",
          "Include the MVP",
        ]);
        return {
          action: "done",
          output: "Corrected",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      });
    const execution = createExecution({ inbox, sessionState: state("") });
    await expect(
      execution.runTurn({ delivery: { kind: "deliver", payloads: [{ message: "2026?" }] } }),
    ).resolves.toMatchObject({ kind: "done", output: "Corrected" });
    expect(cancelDescendantTurnsStep).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "deliver", turnPolicy: "queue", payloads: [{ message: "Queued" }] },
    { kind: "deliver", taskDeliveryId: "task-1:done", payloads: [{ message: "Notification" }] },
    {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "child-request", text: "Answer" }] }],
    },
    { kind: "deliver", caller: { callId: "other-child" }, payloads: [{ message: "Other caller" }] },
  ])(
    "does not interrupt generation for non-steering delivery $kind $turnPolicy $taskDeliveryId",
    async (payload) => {
      let notify: (payload: SessionInboxPayload) => void = () => {};
      const inbox: SessionInbox = {
        claimedTokens: [],
        claimSessionHook: vi.fn(),
        claimSessionHooks: vi.fn(),
        drain: () => [],
        hasPending: () => false,
        next: vi.fn(),
        restore: vi.fn(),
        onInterrupt: () => () => {},
        onDelivery: (handler) => {
          notify = handler;
          return () => {};
        },
      };
      vi.mocked(turnStep)
        .mockReset()
        .mockImplementationOnce(async (input) => {
          notify(payload as SessionInboxPayload);
          expect(input.steeringSignal?.aborted).toBe(false);
          return {
            action: "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        });
      await createExecution({ inbox, sessionState: state("") }).runTurn(undefined);
    },
  );
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
      onDelivery: vi.fn(() => () => {}),
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

  it("consumes the cancelling command while retaining accepted follow-ups", async () => {
    const sessionState = state("");
    const queue = new SessionInputQueue();
    const followUp: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Continue after cancellation." }],
      turnPolicy: "queue",
    };
    let interrupt: ((payload: SessionInboxPayload) => void) | undefined;
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi
        .fn()
        .mockReturnValueOnce([followUp, { kind: "cancel" }])
        .mockReturnValue([]),
      hasPending: vi.fn(() => false),
      next: vi.fn(() => new Promise<never>(() => {})),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn((handler) => {
        interrupt = handler;
        return () => {};
      }),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, queue, sessionState });
    vi.mocked(turnStep).mockImplementationOnce(async (input) => {
      interrupt?.({ kind: "cancel" });
      await vi.waitFor(() => expect(input.abortSignal?.aborted).toBe(true));
      return {
        action: "cancelled",
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      };
    });

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toEqual({ cancelled: true, kind: "park" });

    expect(inbox.restore).not.toHaveBeenCalled();
    expect(queue.takeNext(new Map())).toMatchObject({ delivery: followUp, kind: "turn" });
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
      onDelivery: vi.fn(() => () => {}),
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
      onDelivery: vi.fn(() => () => {}),
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
      onDelivery: vi.fn(() => () => {}),
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
        completion: { kind: "settled", output: "Done." },
      }));

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toMatchObject({ kind: "park", completion: { kind: "settled", output: "Done." } });

    expect(turnStep).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount).toBe(1);
  });

  it.each([
    { backgroundTasks: false, completion: { kind: "settled", output: "Done." } },
    { backgroundTasks: true, completion: { kind: "settled", output: "Done." } },
    { backgroundTasks: false, completion: { kind: "yielded" } },
    { backgroundTasks: true, completion: { kind: "yielded" } },
  ] as const)(
    "keeps a $completion.kind turn when cancellation races its checkpoint (background tasks: $backgroundTasks)",
    async ({ backgroundTasks, completion }) => {
      const followUp: DeliverHookPayload = {
        kind: "deliver",
        payloads: [{ message: "Follow up after completion." }],
      };
      const cancel = { kind: "cancel", turnId: "turn_0" } as const;
      let interrupt: (payload: SessionInboxPayload) => void = () => {};
      const queue = new SessionInputQueue();
      const inbox: SessionInbox = {
        claimedTokens: [],
        claimSessionHook: vi.fn(),
        claimSessionHooks: vi.fn(),
        drain: vi.fn().mockReturnValueOnce([cancel, followUp]).mockReturnValue([]),
        hasPending: () => false,
        next: vi.fn(),
        restore: vi.fn(),
        onDelivery: () => () => {},
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => {};
        },
      };
      const completedState = state("http:completed");
      const execution = createExecution({ inbox, queue, sessionState: state("") });
      vi.mocked(cancelDescendantTurnsStep).mockClear();
      vi.mocked(acknowledgeDelegatedTasksStep).mockReset();
      vi.mocked(turnStep)
        .mockReset()
        .mockImplementationOnce(async (input) => {
          interrupt(cancel);
          expect(input.abortSignal?.aborted).toBe(true);
          return {
            action: "park",
            hasPendingAuthorization: false,
            hasPendingInputBatch: false,
            serializedContext: input.serializedContext,
            sessionState: completedState,
            completion,
            ...(backgroundTasks
              ? {
                  backgroundTaskState: state("http:background"),
                  backgroundTasks: [
                    {
                      callId: "call-1",
                      taskId: "task-1",
                      taskInboxToken: "inbox-1",
                      taskRunId: "run-1",
                    },
                  ],
                }
              : {}),
          };
        });
      await expect(execution.runTurn(undefined)).resolves.toMatchObject({
        kind: "park",
        completion,
      });
      expect(execution.cursor.sessionState).toBe(completedState);
      expect(cancelDescendantTurnsStep).not.toHaveBeenCalled();
      expect(queue.pendingCount).toBe(1);
    },
  );

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
      onDelivery: vi.fn(() => () => {}),
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
        onDelivery: vi.fn(() => () => {}),
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
    sessionWritable: new WritableStream<Uint8Array>(),
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
