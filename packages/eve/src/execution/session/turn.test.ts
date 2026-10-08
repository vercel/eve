import type { TurnPause } from "#execution/session/pending-turn-state.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionExecution } from "#execution/session/turn.js";
import { createTurnControl } from "#execution/session/turn-control.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelTasksStep } from "#execution/tasks/steps.js";
import { turnStep } from "#execution/session/turn-step.js";
import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { publishTurnWaitingStep } from "#execution/session/turn-waiting-step.js";
import {
  withSessionStateDelta,
  type SessionStateValues,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import type { DurableStepResult, TurnStepInput } from "#execution/session/turn-step-types.js";
import type { CoordinationDispatchResult } from "#execution/coordination-dispatch-shared.js";
import type { RoutedDeliverResult } from "#execution/proxied-deliver-step.js";
import {
  createTask,
  readTaskTable,
  recordTaskRun,
  settleTaskCalls,
  writeTaskTable,
} from "#execution/tasks/table.js";
import { getSessionTokenUsage } from "#harness/turn-tag-state.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import {
  emitAgentStartedStep,
  emitWorkflowToolRunReportStep,
} from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { traceTaskToolCallStep } from "#execution/session/task-tool-tracing-step.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://parent.example" }),
}));
vi.mock("#execution/coordination-dispatch-step.js", () => ({ dispatchCoordinationStep: vi.fn() }));

vi.mock("#execution/session/turn-step.js", () => ({
  turnStep: vi.fn(),
}));
vi.mock("#execution/tasks/steps.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelTasksStep: vi.fn(async () => ({ stateDelta: {} })),
}));
vi.mock("#execution/route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));
vi.mock("#execution/tools/workflow/interrupt.js", () => ({
  interruptWorkflowToolRun: vi.fn(),
}));
vi.mock("#execution/session/turn-waiting-step.js", () => ({
  publishTurnWaitingStep: vi.fn(async () => ({ stateDelta: {} })),
}));
vi.mock("#execution/session/task-tool-tracing-step.js", () => ({
  startTaskToolCallsStep: vi.fn(async () => Date.now()),
  traceTaskToolCallStep: vi.fn(async () => ({ stateDelta: {} })),
}));
vi.mock("#execution/tools/workflow/emit-workflow-tool-run-report-step.js", () => ({
  emitAgentStartedStep: vi.fn(),
  emitWorkflowToolRunReportStep: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(traceTaskToolCallStep).mockClear();
  vi.mocked(routeDeliverToChildren)
    .mockReset()
    .mockImplementation(
      routeWork(async ({ delivery, serializedContext, sessionState }) => ({
        kind: "continue",
        remainder: delivery,
        serializedContext,
        sessionState,
      })),
    );
});
afterEach(() => vi.restoreAllMocks());

/** A mocked session step whose work returns whole state, as the real step's work does. */
function stepWork<I extends Partial<SessionStateValues>, R extends Partial<SessionStateValues>>(
  work: (input: I) => Promise<R>,
): (input: I) => Promise<WithSessionStateDelta<R>> {
  return (input) => withSessionStateDelta(input, work);
}
/** These turns leave the history alone, so their work omits it, which the delta reads as unchanged. */
type TurnStepWorkResult = DurableStepResult extends infer R
  ? R extends unknown
    ? Omit<R, "history">
    : never
  : never;
const turnStepWork = stepWork<TurnStepInput, TurnStepWorkResult>;
const dispatchWork = stepWork<
  Parameters<typeof dispatchCoordinationStep>[0],
  CoordinationDispatchResult
>;
const routeWork = stepWork<Parameters<typeof routeDeliverToChildren>[0], RoutedDeliverResult>;

describe("SessionExecution checkpoints", () => {
  it("uses prepared cancellation and steering controls for the first step", async () => {
    const control = createTurnControl();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          expect(input.abortSignal).toBe(control.cancellation.signal);
          expect(input.steeringSignal).toBe(control.steering.signal);
          return {
            action: "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );

    await createExecution({ inbox: idleInbox(), sessionState: state("") }).runTurn(undefined, {
      control,
    });

    expect(turnStep).toHaveBeenCalledOnce();
  });

  it("retains the durable steering signal across steps until a correction uses it", async () => {
    const inbox = idleInbox();
    let signal: AbortSignal | undefined;
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          signal = input.steeringSignal;
          return {
            action: "continue",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          expect(input.steeringSignal).toBe(signal);
          return {
            action: "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );
    await createExecution({ inbox, sessionState: state("") }).runTurn(undefined);
    expect(turnStep).toHaveBeenCalledTimes(2);
  });

  it("reports a compaction from an earlier step when the turn settles", async () => {
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => ({
          action: "continue",
          compacted: true,
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => ({
          action: "parked",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
          settled: { output: "Alice's plan is ready." },
        })),
      );
    const outcome = await createExecution({
      inbox: idleInbox(),
      sessionState: state(""),
    }).runTurn(undefined);
    expect(outcome).toMatchObject({ compacted: true, kind: "park" });
  });
  it("binds the delegated caller on the turn's first step only", async () => {
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: () => [],
      hasPending: () => false,
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(),
      restore: vi.fn(),
      onDelivery: () => () => {},
      onInterrupt: () => () => {},
    };
    const caller: TurnCaller = {
      callId: "call-1",
      replyTo: { kind: "hook", token: "parent" },
      subagentName: "researcher",
    };
    const callers: (TurnCaller | undefined)[] = [];
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async (input) => {
          callers.push(input.caller);
          return {
            action: callers.length === 1 ? "continue" : "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );
    await createExecution({ inbox, sessionState: state("") }).runTurn(undefined, { caller });
    expect(callers).toEqual([caller, undefined]);
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
        whenPending: () => new Promise<void>(() => {}),
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
        .mockImplementationOnce(
          turnStepWork(async (input) => {
            const correction = { kind: "deliver", payloads: [{ message: "Correction" }] } as const;
            pending.push(correction, { kind });
            deliver(correction);
            interrupt({ kind });
            expect(input.steeringSignal?.aborted).toBe(true);
            expect(input.abortSignal?.aborted).toBe(true);
            return {
              action: "continue",
              serializedContext: input.serializedContext,
              sessionState: input.sessionState,
            };
          }),
        );
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
      whenPending: () => new Promise<void>(() => {}),
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
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          pending.push(first);
          notify(first);
          return {
            action: "continue",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          expect(input.input?.delivery?.payloads).toEqual(first.payloads);
          expect(input.steeringSignal?.aborted).toBe(true);
          return {
            action: "continue",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          expect(input.input?.delivery?.payloads).toEqual(second.payloads);
          expect(input.steeringSignal?.aborted).toBe(false);
          return {
            action: "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );
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
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(),
      restore: vi.fn(),
      onInterrupt: () => () => {},
      onDelivery: (handler) => {
        notify = handler;
        return () => {};
      },
    };
    vi.mocked(cancelTasksStep).mockClear();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          for (const message of ["Actually 2025", "Include the MVP"]) {
            const delivery = { kind: "deliver", payloads: [{ message }] } as const;
            pending.push(delivery);
            notify(delivery);
          }
          expect(input.steeringSignal?.aborted).toBe(true);
          expect(input.abortSignal?.aborted).toBe(false);
          return {
            action: "continue",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
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
        }),
      );
    const execution = createExecution({ inbox, sessionState: state("") });
    await expect(
      execution.runTurn({ delivery: { kind: "deliver", payloads: [{ message: "2026?" }] } }),
    ).resolves.toMatchObject({ kind: "done", output: "Corrected" });
    expect(cancelTasksStep).not.toHaveBeenCalled();
  });

  it("lets its caller's next message steer a turn whose input carries no caller", async () => {
    // A delegated session's first turn starts from its initial message; the
    // session binds the caller beside it.
    const firstCall: TurnCaller = {
      callId: "call-1",
      replyTo: { kind: "hook", token: "reply-1" },
      subagentName: "keeper",
    };
    const correction: DeliverHookPayload = {
      caller: { ...firstCall, replyTo: { kind: "hook", token: "reply-2" } },
      kind: "deliver",
      payloads: [{ message: "Alice meant the blue notebook." }],
    };
    let notify: (payload: SessionInboxPayload) => void = () => {};
    const pending: SessionInboxPayload[] = [];
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: () => pending.splice(0),
      hasPending: () => pending.length > 0,
      whenPending: () => new Promise<void>(() => {}),
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
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          pending.push(correction);
          notify(correction);
          expect(input.steeringSignal?.aborted).toBe(true);
          return {
            action: "continue",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          expect(input.input?.delivery?.payloads).toEqual(correction.payloads);
          return {
            action: "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );

    await expect(
      createExecution({ inbox, sessionState: state("") }).runTurn(
        { delivery: { kind: "deliver", payloads: [{ message: "Fill Alice's notebook." }] } },
        { caller: firstCall },
      ),
    ).resolves.toMatchObject({ caller: correction.caller, kind: "done" });
    expect(turnStep).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: "deliver", turnPolicy: "queue", payloads: [{ message: "Queued" }] },
    {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "child-request", text: "Answer" }] }],
    },
    { kind: "deliver", caller: { callId: "other-child" }, payloads: [{ message: "Other caller" }] },
  ])(
    "does not interrupt generation for non-steering delivery $kind $turnPolicy",
    async (payload) => {
      let notify: (payload: SessionInboxPayload) => void = () => {};
      const inbox: SessionInbox = {
        claimedTokens: [],
        claimSessionHook: vi.fn(),
        claimSessionHooks: vi.fn(),
        drain: () => [],
        hasPending: () => false,
        whenPending: () => new Promise<void>(() => {}),
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
        .mockImplementationOnce(
          turnStepWork(async (input) => {
            notify(payload as SessionInboxPayload);
            expect(input.steeringSignal?.aborted).toBe(false);
            return {
              action: "done",
              serializedContext: input.serializedContext,
              sessionState: input.sessionState,
            };
          }),
        );
      await createExecution({ inbox, sessionState: state("") }).runTurn(undefined);
    },
  );
  it("cancels an admitted workflow action when cancellation already arrived at the step boundary", async () => {
    const sessionState = stateWithBlockingRun();
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi
        .fn()
        .mockReturnValueOnce([{ kind: "cancel" }])
        .mockReturnValue([]),
      hasPending: vi.fn(() => false),
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(() => new Promise<never>(() => {})),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({ callIds: ["hold-call"] }),
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep).mockImplementation(
      dispatchWork(async () => ({
        results: [],
        serializedContext: {},
        sessionState,
      })),
    );

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start Alice's deployment" }] },
      }),
    ).resolves.toMatchObject({ cancelled: true, kind: "park" });
    expect(dispatchCoordinationStep).toHaveBeenCalledTimes(1);
    expect(inbox.next).not.toHaveBeenCalled();
    expect(cancelTasksStep).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn_cancelled", turnCalls: true }),
    );
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
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(() => new Promise<never>(() => {})),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn((handler) => {
        interrupt = handler;
        return () => {};
      }),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, queue, sessionState });
    vi.mocked(turnStep).mockImplementationOnce(
      turnStepWork(async (input) => {
        interrupt?.({ kind: "cancel" });
        await vi.waitFor(() => expect(input.abortSignal?.aborted).toBe(true));
        return {
          action: "cancelled",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      }),
    );

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toEqual({ cancelled: true, kind: "park" });

    expect(inbox.restore).not.toHaveBeenCalled();
    expect(queue.takeNext(undefined)).toMatchObject({ delivery: followUp, kind: "turn" });
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
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(() => new Promise<never>(() => {})),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({ callIds: ["hold-call"] }),
          serializedContext: {},
          sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "done",
          output: "done",
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockImplementation(
        dispatchWork(async () => ({
          results: [actionResult],
          serializedContext: {},
          sessionState,
        })),
      );

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
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(() => new Promise<never>(() => {})),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, queue, sessionState: state("") });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async (input) => ({
          action: "parked",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
          settled: { output: "Done." },
        })),
      );

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toMatchObject({
      kind: "park",
      settled: { output: "Done." },
    });

    expect(turnStep).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount).toBe(1);
  });

  it.each([
    { capabilities: undefined, holds: false, serializedContext: {} },
    { capabilities: { requestInput: true }, holds: true, serializedContext: {} },
    {
      capabilities: undefined,
      holds: true,
      serializedContext: { "eve.sessionCallback": { callId: "call_1", token: "parent" } },
    },
  ])(
    "holds on pending input only when someone can answer it: %o",
    async ({ capabilities, holds, serializedContext }) => {
      const inbox: SessionInbox = {
        claimedTokens: [],
        claimSessionHook: vi.fn(),
        claimSessionHooks: vi.fn(),
        drain: vi.fn(() => []),
        hasPending: vi.fn(() => false),
        whenPending: () => new Promise<void>(() => {}),
        next: vi.fn(() => new Promise<never>(() => {})),
        onDelivery: vi.fn(() => () => {}),
        onInterrupt: vi.fn(() => () => {}),
        restore: vi.fn(),
      };
      const execution = createExecution({
        capabilities,
        inbox,
        serializedContext,
        sessionState: state(""),
      });
      vi.mocked(turnStep)
        .mockReset()
        .mockImplementation(
          turnStepWork(async (input) => ({
            action: "paused",
            ...awaitingOn({ requestIds: ["request_1"] }),
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          })),
        );

      const turn = execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Deploy the release." }] },
      });
      if (holds) {
        // Someone can answer, so the turn waits for them.
        const outcome = await Promise.race([
          turn.then(
            () => "settled",
            () => "rejected",
          ),
          new Promise((resolve) => setTimeout(() => resolve("waiting"), 20)),
        ]);
        expect(outcome).toBe("waiting");
      } else {
        await expect(turn).rejects.toThrow("cannot request human input");
      }
    },
  );

  it("preserves the completed turn when cancellation races its checkpoint", async () => {
    const settled = { output: "Done." };
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
      whenPending: () => new Promise<void>(() => {}),
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
    vi.mocked(cancelTasksStep).mockClear();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          interrupt(cancel);
          expect(input.abortSignal?.aborted).toBe(true);
          return {
            action: "parked",
            serializedContext: input.serializedContext,
            sessionState: completedState,
            settled,
          };
        }),
      );
    await expect(execution.runTurn(undefined)).resolves.toMatchObject({
      kind: "park",
      settled,
    });
    expect(execution.cursor.sessionState).toEqual(completedState);
    expect(cancelTasksStep).not.toHaveBeenCalled();
    expect(queue.pendingCount).toBe(1);
  });

  it("routes a proxied answer to a descendant while waiting for runtime results", async () => {
    const sessionState = { ...state(""), hasProxyInputRequests: true };
    const answer: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ inputResponses: [{ requestId: "child-request", text: "blue" }] }],
    };
    const runtimePayloads = [answer, { kind: "cancel" as const }];
    const queue = new SessionInputQueue();
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(async () => runtimePayloads.shift()),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    const execution = createExecution({ inbox, queue, sessionState });
    vi.mocked(turnStep).mockImplementation(
      turnStepWork(async () => ({
        action: "paused",
        ...awaitingOn({ callIds: ["child-call"] }),
        serializedContext: {},
        sessionState,
      })),
    );
    vi.mocked(dispatchCoordinationStep).mockImplementation(
      dispatchWork(async () => ({
        results: [],
        serializedContext: {},
        sessionState,
      })),
    );
    vi.mocked(routeDeliverToChildren).mockImplementation(
      routeWork(async () => ({
        kind: "continue",
        remainder: undefined,
        serializedContext: {},
        sessionState: { ...sessionState, hasProxyInputRequests: false },
      })),
    );

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toEqual({ cancelled: true, kind: "park" });

    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: answer }),
    );
    expect(queue.pendingCount).toBe(0);
  });

  it("routes an answer to its question before the message beside it interrupts the waited call", async () => {
    const base = { ...state(""), hasProxyInputRequests: true };
    const sessionState: DurableSessionState = {
      ...base,
      snapshot: {
        session: registerWorkflowToolRun(base.snapshot.session, {
          address: { hookToken: "deploy-control", runId: "deploy-run" },
          callId: "deploy-call",
          origin: { stepIndex: 0, turnId: "turn_0" },
          toolName: "deploy",
        }),
      },
    };
    const correction: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Also include Bob's service." }],
    };
    const answerAndCorrection: DeliverHookPayload = {
      kind: "deliver",
      payloads: [
        { inputResponses: [{ requestId: "region", text: "us-east-1" }] },
        { message: "Also include Bob's service." },
      ],
    };
    const runtimePayloads: SessionInboxPayload[] = [answerAndCorrection, { kind: "cancel" }];
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(async () => runtimePayloads.shift()),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({ callIds: ["deploy-call"] }),
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockImplementation(
        dispatchWork(async () => ({
          results: [],
          serializedContext: {},
          sessionState,
        })),
      );
    const order: string[] = [];
    vi.mocked(routeDeliverToChildren).mockImplementation(
      routeWork(async (input) => {
        order.push("route");
        return {
          kind: "continue",
          remainder: correction,
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        };
      }),
    );
    vi.mocked(interruptWorkflowToolRun)
      .mockReset()
      .mockImplementation(async () => {
        order.push("interrupt");
      });

    await expect(
      createExecution({ inbox, sessionState }).runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Deploy the release." }] },
      }),
    ).resolves.toEqual({ cancelled: true, kind: "park" });

    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: answerAndCorrection }),
    );
    expect(interruptWorkflowToolRun).toHaveBeenCalledWith({
      hookToken: "deploy-control",
      runId: "deploy-run",
    });
    expect(order).toEqual(["route", "interrupt"]);
  });

  it("reports turn.waiting once when task_wait parks on a working task", async () => {
    const base = state("");
    const working = createTask(readTaskTable(undefined), {
      callId: "task-call",
      kind: "tool",
      name: "research",
      resumable: false,
      turnId: "turn_0",
    });
    const sessionState: DurableSessionState = {
      ...base,
      snapshot: { session: writeTaskTable(base.snapshot.session, working.table) },
    };
    // An unrelated result keeps the wait going for a second pass before the cancel.
    const runtimePayloads: SessionInboxPayload[] = [
      { kind: "runtime-action-result", results: [] },
      { kind: "cancel" },
    ];
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(async () => runtimePayloads.shift()),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({
            callIds: ["wait-call"],
            dispatch: false,
            taskToolCalls: [{ callId: "wait-call", kind: "eve__task_wait" }],
          }),
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep).mockClear();
    vi.mocked(cancelTasksStep).mockClear();

    await expect(
      createExecution({ inbox, sessionState }).runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Wait for the research." }] },
      }),
    ).resolves.toEqual({ cancelled: true, kind: "park" });

    expect(publishTurnWaitingStep).toHaveBeenCalledTimes(1);
    expect(publishTurnWaitingStep).toHaveBeenCalledWith(expect.objectContaining({ sessionState }));
    // Only a task tool call is pending: nothing is dispatched, and the cancel has
    // no workflow tool run to stop.
    expect(dispatchCoordinationStep).not.toHaveBeenCalled();
    expect(cancelTasksStep).toHaveBeenCalledWith(expect.objectContaining({ turnCalls: false }));
    expect(traceTaskToolCallStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callId: "wait-call",
        toolName: "eve__task_wait",
        failed: true,
        startedAtMs: expect.any(Number),
        completedAtMs: expect.any(Number),
      }),
    );
  });

  it("admits an idle agent task's usage report while the turn waits and counts it", async () => {
    const base = state("");
    // Alice's reviewer task answered earlier and is idle; its run is still live.
    const created = createTask(readTaskTable(undefined), {
      callId: "review-call",
      kind: "agent",
      name: "reviewer",
      resumable: true,
      turnId: "turn_0",
    });
    const running = recordTaskRun(created.table, created.taskId, {
      hookToken: "reviewer-control",
      runId: "reviewer-run",
    });
    const idle = settleTaskCalls(running, {
      callIds: ["review-call"],
      outcome: { output: "The plan looks ready.", status: "completed" },
      taskId: created.taskId,
    }).table;
    const sessionState: DurableSessionState = {
      ...base,
      snapshot: { session: writeTaskTable(base.snapshot.session, idle) },
    };
    // A turn of the reviewer that no reply answers ends while Alice's turn waits on a call.
    const payloads: SessionInboxPayload[] = [
      {
        from: {
          callId: "review-call",
          input: {},
          runId: "reviewer-run",
          sequence: 0,
          stepIndex: 0,
          taskId: created.taskId,
          toolName: "reviewer",
          turnId: "turn_0",
        },
        kind: "usage",
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 250, outputTokens: 25 },
      },
      { kind: "cancel" },
    ];
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(async () => payloads.shift()),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({ callIds: ["hold-call"] }),
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockImplementation(
        dispatchWork(async () => ({ results: [], serializedContext: {}, sessionState })),
      );
    const cursor = new SessionStateCursor({
      history: [],
      inbox,
      serializedContext: {},
      sessionState,
      sessionWritable: new WritableStream<Uint8Array>(),
    });
    const execution = new SessionExecution({
      cursor,
      inbox,
      queue: new SessionInputQueue(),
      sessionId: sessionState.sessionId,
    });

    await expect(
      execution.runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Hold the release." }] },
      }),
    ).resolves.toEqual({ cancelled: true, kind: "park" });

    expect(getSessionTokenUsage(cursor.sessionState.snapshot.session)).toMatchObject({
      inputTokens: 250,
      outputTokens: 25,
    });
  });

  it("hands the step each workflow run's delegated usage once, even when its outcome arrives twice", async () => {
    const base = state("");
    const tools = ["draft", "review"];
    const sessionState: DurableSessionState = {
      ...base,
      snapshot: {
        session: tools.reduce(
          (session, name) =>
            registerWorkflowToolRun(session, {
              address: { hookToken: `${name}-control`, runId: `${name}-run` },
              callId: `${name}-call`,
              origin: { stepIndex: 0, turnId: "turn_0" },
              toolName: name,
            }),
          base.snapshot.session,
        ),
      },
    };
    const spent = (inputTokens: number): TokenUsage => ({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens,
      outputTokens: 0,
    });
    const outcome = (name: string, inputTokens: number): SessionInboxPayload => ({
      from: {
        callId: `${name}-call`,
        input: {},
        runId: `${name}-run`,
        sequence: 0,
        stepIndex: 0,
        toolName: name,
        turnId: "turn_0",
      },
      kind: "outcome",
      result: { output: `${name} finished`, status: "completed" },
      usage: spent(inputTokens),
    });
    // The draft's outcome is delivered twice before the review finishes.
    const payloads = [outcome("draft", 300), outcome("draft", 300), outcome("review", 500)];
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      whenPending: () => new Promise<void>(() => {}),
      next: vi.fn(async () => payloads.shift() ?? new Promise<never>(() => {})),
      onDelivery: vi.fn(() => () => {}),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({ callIds: tools.map((name) => `${name}-call`) }),
          serializedContext: {},
          sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "done",
          output: "done",
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockImplementation(
        dispatchWork(async () => ({ results: [], serializedContext: {}, sessionState })),
      );

    await expect(
      createExecution({ inbox, sessionState }).runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Draft the plan and review it." }] },
      }),
    ).resolves.toMatchObject({ kind: "done" });

    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input?.runtimeResults?.delegatedUsage).toEqual([
      spent(300),
      spent(500),
    ]);
  });

  it("does not let steering that woke a wait interrupt the step that reads it", async () => {
    const base = state("");
    const working = createTask(readTaskTable(undefined), {
      callId: "task-call",
      kind: "tool",
      name: "research",
      resumable: false,
      turnId: "turn_0",
    });
    const sessionState: DurableSessionState = {
      ...base,
      snapshot: { session: writeTaskTable(base.snapshot.session, working.table) },
    };
    const steering: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Also check Bob's notes." }],
    };
    let signalDelivery: (payload: SessionInboxPayload) => void = () => {};
    const inbox: SessionInbox = {
      claimedTokens: [],
      claimSessionHook: vi.fn(),
      claimSessionHooks: vi.fn(),
      drain: vi.fn(() => []),
      hasPending: vi.fn(() => false),
      whenPending: () => new Promise<void>(() => {}),
      // The pump signals a delivery as it arrives, then the wait reads it.
      next: vi.fn(async () => {
        signalDelivery(steering);
        return steering;
      }),
      onDelivery: vi.fn((handler) => {
        signalDelivery = handler;
        return () => {};
      }),
      onInterrupt: vi.fn(() => () => {}),
      restore: vi.fn(),
    };
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockImplementation(
        dispatchWork(async () => ({
          results: [],
          serializedContext: {},
          sessionState,
        })),
      );
    let continuation: { delivery?: DeliverHookPayload; steered?: boolean } = {};
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({
            callIds: ["wait-call"],
            dispatch: false,
            taskToolCalls: [{ callId: "wait-call", kind: "eve__task_wait" }],
          }),
          serializedContext: {},
          sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          continuation = {
            delivery: input.input?.delivery,
            steered: input.steeringSignal?.aborted,
          };
          return { action: "done", output: "done", serializedContext: {}, sessionState };
        }),
      );

    await expect(
      createExecution({ inbox, sessionState }).runTurn({
        delivery: { kind: "deliver", payloads: [{ message: "Wait for the research." }] },
      }),
    ).resolves.toMatchObject({ kind: "done" });

    expect(continuation).toEqual({ delivery: steering, steered: false });
  });

  it("publishes and adopts consecutive boundary agent-started messages in one step, keeping admission order", async () => {
    const { inbox, planner, progress, reviewer, writer } = boundaryRunMessages();
    const cursor = createCursor({ inbox, sessionState: state("") });
    publishIntoContext();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => ({
          action: "parked",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
          settled: { output: "Done." },
        })),
      );
    inbox.drain = vi
      .fn()
      .mockReturnValueOnce([planner, reviewer, progress, writer])
      .mockReturnValue([]);

    await expect(
      createExecution({ cursor, inbox, sessionState: cursor.sessionState }).runTurn(undefined),
    ).resolves.toMatchObject({ kind: "park", settled: { output: "Done." } });

    expect(cursor.serializedContext[PUBLISHED]).toEqual([
      "planner-session+reviewer-session",
      "Halfway through the sources.",
      "writer-session",
    ]);
  });

  it("announces no child when the step ends the session, whose stream it closed", async () => {
    const { inbox, planner, progress } = boundaryRunMessages();
    const sessionState = state("");
    const cursor = createCursor({ inbox, sessionState });
    publishIntoContext();
    inbox.drain = vi.fn().mockReturnValueOnce([planner, progress]).mockReturnValue([]);
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({ action: "done", serializedContext: {}, sessionState })),
      );

    await expect(
      createExecution({ cursor, inbox, sessionState }).runTurn(undefined),
    ).resolves.toMatchObject({ kind: "done" });

    // The boundary still ran: it handled the task's report and dropped only the child.
    expect(cursor.serializedContext[PUBLISHED]).toEqual(["Halfway through the sources."]);
    expect(emitAgentStartedStep).not.toHaveBeenCalled();
  });

  it("announces a child opened before a cancel ahead of cancelling the turn's work", async () => {
    const { inbox, planner } = boundaryRunMessages();
    const sessionState = stateWithBlockingRun();
    let interrupt: (payload: SessionInboxPayload) => void = () => {};
    inbox.onInterrupt = (handler) => {
      interrupt = handler;
      return () => {};
    };
    // Bob cancels while the turn waits, just as Alice's run opens a planner.
    inbox.next = vi.fn(async () => {
      interrupt({ kind: "cancel" });
      return planner;
    });
    publishIntoContext();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...awaitingOn({ callIds: ["hold-call"] }),
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep).mockImplementation(
      dispatchWork(async () => ({ results: [], serializedContext: {}, sessionState })),
    );

    await expect(createExecution({ inbox, sessionState }).runTurn(undefined)).resolves.toEqual({
      cancelled: true,
      kind: "park",
    });

    const [announced] = vi.mocked(emitAgentStartedStep).mock.invocationCallOrder;
    const [cancelled] = vi.mocked(cancelTasksStep).mock.invocationCallOrder;
    expect(announced).toBeLessThan(cancelled!);
  });
});

/** The context key the mocked publishing steps append to, as a hook's state write would. */
const PUBLISHED = "test.published";

/** Mocks the run-message publishing steps to record what they publish in the session context. */
function publishIntoContext(): void {
  const append = (context: Record<string, unknown>, entry: string) => ({
    serializedContext: {
      ...context,
      [PUBLISHED]: [...((context[PUBLISHED] as string[] | undefined) ?? []), entry],
    },
  });
  vi.mocked(emitAgentStartedStep)
    .mockReset()
    .mockImplementation(
      stepWork(async (input: Parameters<typeof emitAgentStartedStep>[0]) =>
        append(
          input.serializedContext,
          input.messages.map((message) => message.session.sessionId).join("+"),
        ),
      ),
    );
  vi.mocked(emitWorkflowToolRunReportStep)
    .mockReset()
    .mockImplementation(
      stepWork(async (input: Parameters<typeof emitWorkflowToolRunReportStep>[0]) =>
        append(input.serializedContext, String(input.update)),
      ),
    );
}

/**
 * Alice's runs open a planner, a reviewer, and a writer, and her research task
 * reports progress, with an inbox that has nothing else to admit.
 */
function boundaryRunMessages() {
  const from = (callId: string, taskId?: string): WorkflowToolRunRef => ({
    callId,
    input: {},
    runId: `run-${callId}`,
    sequence: 0,
    stepIndex: 0,
    ...(taskId !== undefined && { taskId }),
    toolName: "execute",
    turnId: "turn_0",
  });
  const opened = (callId: string, name: string): WorkflowToolRunMessage => ({
    from: from(callId),
    kind: "agent-started",
    session: { kind: "local", name, nodeId: name, sessionId: `${name}-session` },
  });
  const inbox: SessionInbox = {
    claimedTokens: [],
    claimSessionHook: vi.fn(),
    claimSessionHooks: vi.fn(),
    drain: () => [],
    hasPending: () => false,
    whenPending: () => new Promise<void>(() => {}),
    next: vi.fn(() => new Promise<never>(() => {})),
    restore: vi.fn(),
    onDelivery: () => () => {},
    onInterrupt: () => () => {},
  };
  return {
    inbox,
    planner: opened("call-1", "planner"),
    progress: {
      from: from("call-3", "research"),
      kind: "report",
      update: "Halfway through the sources.",
    } satisfies WorkflowToolRunMessage,
    reviewer: opened("call-2", "reviewer"),
    writer: opened("call-4", "writer"),
  };
}

function createCursor(input: {
  readonly inbox: SessionInbox;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): SessionStateCursor {
  return new SessionStateCursor({
    history: [],
    inbox: input.inbox,
    sessionWritable: new WritableStream<Uint8Array>(),
    serializedContext: input.serializedContext ?? {},
    sessionState: input.sessionState,
  });
}

function idleInbox(): SessionInbox {
  return {
    claimedTokens: [],
    claimSessionHook: vi.fn(),
    claimSessionHooks: vi.fn(),
    drain: () => [],
    hasPending: () => false,
    whenPending: () => new Promise<void>(() => {}),
    next: vi.fn(),
    restore: vi.fn(),
    onDelivery: () => () => {},
    onInterrupt: () => () => {},
  };
}

function createExecution(input: {
  readonly capabilities?: SessionCapabilities;
  readonly cursor?: SessionStateCursor;
  readonly inbox: SessionInbox;
  readonly queue?: SessionInputQueue;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): SessionExecution {
  const cursor = input.cursor ?? createCursor(input);
  return new SessionExecution({
    capabilities: input.capabilities,
    cursor,
    inbox: input.inbox,
    queue: input.queue ?? new SessionInputQueue(),
    sessionId: input.sessionState.sessionId,
  });
}

/** A session whose turn waits on a workflow tool run, so cancelling it has a run to cancel. */
function stateWithBlockingRun(): DurableSessionState {
  const base = state("");
  return {
    ...base,
    snapshot: {
      session: registerWorkflowToolRun(base.snapshot.session, {
        address: { hookToken: "hold-control", runId: "hold-run" },
        callId: "hold-call",
        origin: { stepIndex: 0, turnId: "turn_0" },
        toolName: "hold",
      }),
    },
  };
}

function state(continuationToken: string): DurableSessionState {
  return createTestSessionState({
    continuationToken,
    hasProxyInputRequests: false,
    sessionId: "session-1",
  });
}

/** A paused step's fields: what it awaits, and whether it has runs to start. */
function awaitingOn(input: {
  readonly attemptIds?: readonly string[];
  readonly callIds?: readonly string[];
  readonly dispatch?: boolean;
  readonly requestIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly taskToolCalls?: TurnPause["taskToolCalls"];
}): TurnPause {
  return {
    awaiting: {
      attemptIds: input.attemptIds ?? [],
      callIds: input.callIds ?? [],
      requestIds: input.requestIds ?? [],
      taskIds: input.taskIds ?? [],
    },
    dispatch: input.dispatch ?? true,
    taskToolCalls: input.taskToolCalls ?? [],
  };
}
