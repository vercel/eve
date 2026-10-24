import { sleep } from "#compiled/@workflow/core/index.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { startTaskToolCallsStep } from "#execution/session/task-tool-tracing-step.js";
import type { TurnPause } from "#execution/session/step-decision.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { SessionInbox, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { SessionLoop, type SessionLoopInput } from "#execution/session/session-loop.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelTasksStep } from "#execution/tasks/steps.js";
import { turnStep } from "#execution/session/turn-step.js";
import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import {
  dispatchCoordinationStep,
  publishDispatchedCallsStep,
} from "#execution/coordination-dispatch-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import {
  type SessionStateValues,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import type {
  DurableStepResult,
  TurnStepInput,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import type { CoordinationDispatchResult } from "#execution/coordination-dispatch-shared.js";
import type { RoutedDeliverResult } from "#execution/proxied-deliver-step.js";
import {
  createTask,
  readTaskTable,
  recordTaskRun,
  settleTaskCalls,
  writeTaskTable,
} from "#execution/tasks/table.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import { applyRunMessagesStep } from "#execution/tools/workflow/apply-run-messages-step.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import type { TokenUsage } from "#shared/token-usage.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ url: "https://parent.example" }),
  sleep: vi.fn(),
}));
vi.mock("#execution/coordination-dispatch-step.js", () => ({
  dispatchCoordinationStep: vi.fn(),
  publishDispatchedCallsStep: vi.fn(async () => ({ stateDelta: {} })),
}));

// A task run's late spend publishes a fact; this suite's sessions carry no bundle to publish with.
const committed = vi.hoisted((): unknown[] => []);

vi.mock("#execution/publish-session-events.js", async (importOriginal) => {
  const { readDurableSession } = await import("#execution/durable-session-store.js");
  const { sessionView } = await import("#harness/session-machine/commit.js");
  const { storedProjection } = await import("#harness/session-machine/view.js");
  const unchanged = vi.fn(
    async (target: { serializedContext: Record<string, unknown>; sessionState: unknown }) => ({
      serializedContext: target.serializedContext,
      sessionState: target.sessionState,
    }),
  );
  return {
    ...(await importOriginal()),
    publishSessionEvents: unchanged,
    // Task steps commit through it: record what they decide; the state they saved comes back.
    commitSessionStep: vi.fn(
      async (
        target: { serializedContext: Record<string, unknown>; sessionState: DurableSessionState },
        decide: (view: SessionView) => readonly { readonly events: readonly unknown[] }[],
      ) => {
        const { state } = readDurableSession(target.sessionState);
        committed.push(
          ...decide(sessionView(storedProjection(state), state)).flatMap((t) => t.events),
        );
        return { serializedContext: target.serializedContext, sessionState: target.sessionState };
      },
    ),
  };
});
vi.mock("#execution/session/turn-step.js", () => ({
  turnStep: vi.fn(),
}));
vi.mock("#execution/tasks/steps.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelTasksStep: vi.fn(async () => ({ stateDelta: {} })),
}));
vi.mock("#execution/settle-cancelled-turn-step.js", () => ({
  settleCancelledTurnStep: vi.fn(async () => ({ stateDelta: {} })),
}));
vi.mock("#execution/route-child-delivery.js", () => ({
  routeDeliverToChildren: vi.fn(),
}));
vi.mock("#execution/tools/workflow/interrupt.js", () => ({
  interruptWorkflowToolRun: vi.fn(),
}));
vi.mock("#execution/session/task-tool-tracing-step.js", () => ({
  startTaskToolCallsStep: vi.fn(async () => Date.now()),
}));
vi.mock("#execution/tools/workflow/apply-run-messages-step.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#execution/tools/workflow/apply-run-messages-step.js")>();
  return { ...actual, applyRunMessagesStep: vi.fn(actual.applyRunMessagesStep) };
});

beforeEach(() => {
  // Tests that record publishing replace the real step; the rest apply messages for real.
  vi.mocked(applyRunMessagesStep).mockReset();
  vi.mocked(settleCancelledTurnStep).mockClear();
  vi.mocked(publishDispatchedCallsStep).mockClear();
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
function dispatchWork(
  work: (
    input: Parameters<typeof dispatchCoordinationStep>[0],
  ) => Promise<Omit<CoordinationDispatchResult, "pending">>,
) {
  return stepWork(async (input: Parameters<typeof dispatchCoordinationStep>[0]) => ({
    ...(await work(input)),
    pending: { executing: [], refused: [], started: [] },
  }));
}
const routeWork = stepWork<Parameters<typeof routeDeliverToChildren>[0], RoutedDeliverResult>;

describe("SessionLoop turns", () => {
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

    await createExecution({ inbox: idleInbox(), sessionState: state("") }).runSession(undefined, {
      control,
    });

    expect(turnStep).toHaveBeenCalledOnce();
  });

  it("publishes dispatch receipts before immediate results resume the turn", async () => {
    const pending = {
      executing: [{ type: "call.started" as const, data: { callId: "deploy-call" } }],
      refused: [],
      started: [],
    };
    const results = [
      {
        kind: "tool-result" as const,
        callId: "deploy-call",
        toolName: "deploy",
        output: "deployed",
      },
    ];
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockResolvedValueOnce({ pending, results, stateDelta: {} });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => ({
          action: "paused",
          ...callsPause({ callIds: ["deploy-call"] }),
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          expect(input.input?.runtimeResults?.results).toEqual(results);
          return {
            action: "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );
    await createExecution({ inbox: idleInbox(), sessionState: state("") }).runSession(undefined);
    expect(publishDispatchedCallsStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pending }),
    );
    expect(vi.mocked(dispatchCoordinationStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(publishDispatchedCallsStep).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(publishDispatchedCallsStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(turnStep).mock.invocationCallOrder[1]!,
    );
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
    await createExecution({ inbox, sessionState: state("") }).runSession(undefined);
    expect(turnStep).toHaveBeenCalledTimes(2);
  });

  it("moves a session that compacted in an earlier step to a fresh run once the turn settles", async () => {
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
    const handoff = {
      tryCompactionTransfer: vi.fn(async () => ({ kind: "transferred" as const })),
      tryPrewarmTransfer: vi.fn(),
      tryTransfer: vi.fn(),
    };

    await expect(
      createExecution({ handoff, inbox: idleInbox(), sessionState: state("") }).runSession(
        undefined,
      ),
    ).resolves.toEqual({ kind: "transferred" });
    expect(handoff.tryCompactionTransfer).toHaveBeenCalledOnce();
  });
  it("binds the delegated caller on the turn's first step only", async () => {
    const inbox: SessionInbox = {
      ...idleInbox(),
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
    await createExecution({ inbox, sessionState: state("") }).runSession(undefined, { caller });
    expect(callers).toEqual([caller, undefined]);
  });
  it("does not interrupt generation for an already admitted delivery key", async () => {
    let deliver: (payload: SessionInboxPayload) => void = () => {};
    const inbox: SessionInbox = {
      ...idleInbox(),
      onDelivery(handler) {
        deliver = handler;
        return () => {};
      },
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          deliver({
            kind: "send",
            idempotencyKey: "accepted",
            payload: { message: "Alice's earlier message." },
          });
          expect(input.steeringSignal?.aborted).toBe(false);
          deliver({
            kind: "send",
            idempotencyKey: "new",
            payload: { message: "Alice corrects the report." },
          });
          expect(input.steeringSignal?.aborted).toBe(true);
          return {
            action: "parked",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );
    await createExecution({
      inbox,
      admittedDeliveryKeys: ["accepted"],
      sessionState: state(""),
    }).runSession(undefined);
  });

  it.each(["cancel", "reset"] as const)(
    "gives %s precedence over generation steering",
    async (kind) => {
      let deliver: (payload: SessionInboxPayload) => void = () => {};
      let interrupt: (payload: SessionInboxPayload) => void = () => {};
      const pending: SessionInboxPayload[] = [];
      const inbox: SessionInbox = {
        ...idleInbox(),
        drain: () => pending.splice(0),
        hasPending: () => pending.length > 0,
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
        .mockImplementation(
          turnStepWork(async (input) => ({
            action: "done",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          })),
        )
        .mockImplementationOnce(
          turnStepWork(async (input) => {
            const correction = { kind: "deliver", payloads: [{ message: "Correction" }] } as const;
            pending.push(correction, { kind, deliveryId: `${kind}-delivery` });
            deliver(correction);
            interrupt({ kind, deliveryId: `${kind}-delivery` });
            expect(input.steeringSignal?.aborted).toBe(true);
            expect(input.abortSignal?.aborted).toBe(true);
            return {
              action: "continue",
              serializedContext: input.serializedContext,
              sessionState: input.sessionState,
            };
          }),
        );
      await createExecution({ inbox, sessionState: state("") }).runSession(undefined);

      // The turn stops as cancelled; the correction waits for the next turn.
      expect(settleCancelledTurnStep).toHaveBeenCalledWith(
        expect.objectContaining({
          control: kind === "cancel" ? { deliveryId: "cancel-delivery" } : undefined,
        }),
      );
      const [settled] = vi.mocked(settleCancelledTurnStep).mock.invocationCallOrder;
      const [, next] = vi.mocked(turnStep).mock.invocationCallOrder;
      expect(settled).toBeLessThan(next!);
      expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({
        delivery: expect.objectContaining({ payloads: [{ message: "Correction" }] }),
      });
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
      ...idleInbox(),
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
    await createExecution({ inbox, sessionState: state("") }).runSession(undefined);
    expect(turnStep).toHaveBeenCalledTimes(3);
  });
  it("signals generation steering, coalesces corrections in order, and continues without cancellation", async () => {
    let notify: (payload: SessionInboxPayload) => void = () => {};
    const pending: SessionInboxPayload[] = [];
    const inbox: SessionInbox = {
      ...idleInbox(),
      drain: () => pending.splice(0),
      hasPending: () => pending.length > 0,
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
      execution.runSession({ delivery: { kind: "deliver", payloads: [{ message: "2026?" }] } }),
    ).resolves.toMatchObject({ kind: "done", outcome: { output: "Corrected" } });
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
      ...idleInbox(),
      drain: () => pending.splice(0),
      hasPending: () => pending.length > 0,
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
      createExecution({ inbox, sessionState: state("") }).runSession(
        { delivery: { kind: "deliver", payloads: [{ message: "Fill Alice's notebook." }] } },
        { caller: firstCall },
      ),
    ).resolves.toMatchObject({ kind: "done", outcome: { caller: correction.caller } });
    expect(turnStep).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: "deliver", turnPolicy: "queue", payloads: [{ message: "Queued" }] },
    {
      kind: "deliver",
      payloads: [{ answers: [{ requestId: "child-request", text: "Answer" }] }],
    },
    { kind: "deliver", caller: { callId: "other-child" }, payloads: [{ message: "Other caller" }] },
  ])(
    "does not interrupt generation for non-steering delivery $kind $turnPolicy",
    async (payload) => {
      let notify: (payload: SessionInboxPayload) => void = () => {};
      const inbox: SessionInbox = {
        ...idleInbox(),
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
      await createExecution({ inbox, sessionState: state("") }).runSession(undefined);
    },
  );
  it("cancels an admitted workflow action when cancellation already arrived at the step boundary", async () => {
    const sessionState = stateWithBlockingRun();
    const inbox: SessionInbox = {
      ...idleInbox(),
      drain: vi
        .fn()
        .mockReturnValueOnce([{ deliveryId: "cancel-delivery", kind: "cancel" }])
        .mockReturnValue([]),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: ["hold-call"] }),
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
      execution.runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Start Alice's deployment" }] },
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(dispatchCoordinationStep).toHaveBeenCalledTimes(1);
    // The turn stops before it waits on its call: the session reads its inbox only once it settled.
    const [settled] = vi.mocked(settleCancelledTurnStep).mock.invocationCallOrder;
    const [read] = vi.mocked(inbox.next).mock.invocationCallOrder;
    expect(settled).toBeLessThan(read!);
    expect(cancelTasksStep).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "turn-cancelled", turnCalls: true }),
    );
  });

  it("consumes the cancelling command while retaining accepted follow-ups", async () => {
    const sessionState = state("");
    const followUp: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Continue after cancellation." }],
      turnPolicy: "queue",
    };
    let interrupt: ((payload: SessionInboxPayload) => void) | undefined;
    const inbox: SessionInbox = {
      ...idleInbox(),
      drain: vi
        .fn()
        .mockReturnValueOnce([followUp, { deliveryId: "cancel-delivery", kind: "cancel" }])
        .mockReturnValue([]),
      next: vi.fn(() => new Promise<never>(() => {})),
      onInterrupt: vi.fn((handler) => {
        interrupt = handler;
        return () => {};
      }),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async (input) => ({
          action: "done",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => {
          interrupt?.({ deliveryId: "cancel-delivery", kind: "cancel" });
          await vi.waitFor(() => expect(input.abortSignal?.aborted).toBe(true));
          return {
            action: "cancelled",
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          };
        }),
      );

    await expect(
      execution.runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toMatchObject({ kind: "done" });
    expect(settleCancelledTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ control: { deliveryId: "cancel-delivery" } }),
    );

    // The follow-up starts the next turn.
    expect(inbox.restore).not.toHaveBeenCalled();
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({ delivery: followUp });
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
      ...idleInbox(),
      drain: vi.fn().mockReturnValueOnce([steering]).mockReturnValue([]),
      next: vi.fn(() => new Promise<never>(() => {})),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: ["hold-call"] }),
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
      execution.runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toMatchObject({ kind: "done", outcome: { output: "done" } });

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
    const inbox: SessionInbox = {
      ...idleInbox(),
      drain: vi.fn().mockReturnValueOnce([followUp]).mockReturnValue([]),
    };
    const execution = createExecution({ inbox, sessionState: state("") });
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
      execution.runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toEqual({ kind: "expired" });

    expect(turnStep).toHaveBeenCalledTimes(2);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({ delivery: followUp });
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
        ...idleInbox(),
        next: vi.fn(() => new Promise<never>(() => {})),
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
            ...({
              attemptIds: [],
              on: "interaction",
              requestIds: ["request_1"],
            } satisfies TurnPause),
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          })),
        );

      const turn = execution.runSession({
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

  it.each([
    { attemptIds: [], requestIds: ["request_1"] },
    { attemptIds: ["attempt_1"], requestIds: [] },
  ])(
    "fails a turn that needs a person when its caller speaks an earlier protocol: %o",
    async (pause) => {
      const inbox: SessionInbox = {
        ...idleInbox(),
        next: vi.fn(() => new Promise<never>(() => {})),
      };
      const execution = createExecution({
        capabilities: { requestInput: false },
        inbox,
        serializedContext: {
          "eve.earlierRemoteCaller": 2,
          "eve.sessionCallback": { callId: "call_1", token: "parent" },
        },
        sessionState: state(""),
      });
      vi.mocked(turnStep)
        .mockReset()
        .mockImplementation(
          turnStepWork(async (input) => ({
            action: "paused",
            ...({ on: "interaction", ...pause } satisfies TurnPause),
            serializedContext: input.serializedContext,
            sessionState: input.sessionState,
          })),
        );

      await expect(
        execution.runSession({
          delivery: { kind: "deliver", payloads: [{ message: "Deploy the release." }] },
        }),
      ).rejects.toThrow("speaks eve remote agent protocol 2");
    },
  );

  it("preserves the completed turn when cancellation races its checkpoint", async () => {
    const settled = { output: "Done." };
    const followUp: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ message: "Follow up after completion." }],
    };
    const cancel = { deliveryId: "cancel-delivery", kind: "cancel", turnId: "turn_0" } as const;
    let interrupt: (payload: SessionInboxPayload) => void = () => {};
    const inbox: SessionInbox = {
      ...idleInbox(),
      drain: vi.fn().mockReturnValueOnce([cancel, followUp]).mockReturnValue([]),
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {};
      },
    };
    const completedState = state("http:completed");
    const execution = createExecution({ inbox, sessionState: state("") });
    vi.mocked(cancelTasksStep).mockClear();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async (input) => ({
          action: "done",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        })),
      )
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
    await expect(execution.runSession(undefined)).resolves.toMatchObject({ kind: "done" });

    // The cancel found the turn settled: the follow-up's turn starts from what the turn saved.
    expect(cancelTasksStep).not.toHaveBeenCalled();
    expect(settleCancelledTurnStep).not.toHaveBeenCalled();
    expect(vi.mocked(turnStep).mock.calls[1]?.[0]).toMatchObject({
      input: { delivery: followUp },
      sessionState: completedState,
    });
  });

  it("routes a proxied answer to a descendant while waiting for runtime results", async () => {
    const sessionState = { ...state(""), hasProxyInputRequests: true };
    const answer: DeliverHookPayload = {
      kind: "deliver",
      payloads: [{ answers: [{ interactionId: "child-request", text: "blue" }] }],
    };
    const runtimePayloads = [answer, { kind: "cancel" as const, deliveryId: "cancel-delivery" }];
    const inbox: SessionInbox = {
      ...idleInbox(),
      next: vi.fn(async () => runtimePayloads.shift()),
    };
    const execution = createExecution({ inbox, sessionState });
    vi.mocked(turnStep).mockImplementation(
      turnStepWork(async () => ({
        action: "paused",
        ...callsPause({ callIds: ["child-call"] }),
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
      execution.runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Start the work." }] },
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(settleCancelledTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ control: { deliveryId: "cancel-delivery" } }),
    );

    // The descendant took the whole answer: nothing is left for a turn of the session's own.
    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: answer }),
    );
    expect(turnStep).toHaveBeenCalledOnce();
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
        { answers: [{ interactionId: "region", text: "us-east-1" }] },
        { message: "Also include Bob's service." },
      ],
    };
    const runtimePayloads: SessionInboxPayload[] = [
      answerAndCorrection,
      { deliveryId: "cancel-delivery", kind: "cancel" },
    ];
    const inbox: SessionInbox = {
      ...idleInbox(),
      next: vi.fn(async () => runtimePayloads.shift()),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({ action: "done", serializedContext: {}, sessionState })),
      )
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: ["deploy-call"] }),
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
      createExecution({ inbox, sessionState }).runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Deploy the release." }] },
      }),
    ).resolves.toMatchObject({ kind: "done" });
    expect(settleCancelledTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ control: { deliveryId: "cancel-delivery" } }),
    );

    expect(routeDeliverToChildren).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: answerAndCorrection }),
    );
    expect(interruptWorkflowToolRun).toHaveBeenCalledWith({
      hookToken: "deploy-control",
      runId: "deploy-run",
    });
    // The correction outlived the cancelled turn: it starts the next one as its input, already
    // routed once.
    expect(order).toEqual(["route", "interrupt"]);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input).toEqual({ delivery: correction });
  });

  it.each(["pending input", "simultaneous input", "timeout"] as const)(
    "orders a task-wait deadline against %s",
    async (wake) => {
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
      const inbox = idleInbox();
      inbox.hasPending = () => wake === "pending input";
      if (wake === "simultaneous input") inbox.whenPending = async () => {};
      const payloads: SessionInboxPayload[] =
        wake === "timeout" ? [] : [{ deliveryId: "cancel-wait", kind: "cancel" }];
      inbox.next = vi.fn(async () => payloads.shift());
      vi.mocked(sleep).mockReset().mockResolvedValue(undefined);
      vi.mocked(startTaskToolCallsStep).mockResolvedValueOnce(2000);
      vi.mocked(turnStep)
        .mockReset()
        .mockImplementationOnce(
          turnStepWork(async () => ({
            action: "paused",
            ...callsPause({
              callIds: ["wait-call"],
              dispatch: false,
              taskToolCalls: [{ callId: "wait-call", kind: "eve__task_wait", timeoutMs: 1000 }],
            }),
            serializedContext: {},
            sessionState,
          })),
        )
        .mockImplementationOnce(
          turnStepWork(async (input) => {
            expect(input.input?.runtimeResults?.results).toEqual([
              expect.objectContaining({
                callId: "wait-call",
                output: expect.stringContaining("Stopped waiting"),
              }),
            ]);
            return { action: "done", serializedContext: {}, sessionState };
          }),
        );
      const ended = await createExecution({ inbox, sessionState }).runSession(undefined);
      expect(ended.kind).toBe(wake === "timeout" ? "done" : "expired");
      expect(turnStep).toHaveBeenCalledTimes(wake === "timeout" ? 2 : 1);
      expect(sleep).toHaveBeenCalledTimes(wake === "pending input" ? 0 : 1);
      if (wake !== "pending input") expect(sleep).toHaveBeenCalledWith(new Date(3000));
    },
  );

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
      { deliveryId: "cancel-delivery", kind: "cancel" },
    ];
    const inbox: SessionInbox = {
      ...idleInbox(),
      next: vi.fn(async () => runtimePayloads.shift()),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({
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
      createExecution({ inbox, sessionState }).runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Wait for the research." }] },
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(settleCancelledTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ control: { deliveryId: "cancel-delivery" } }),
    );

    // Only a task tool call is pending: nothing is dispatched, and the cancel has
    // no workflow tool run to stop.
    expect(dispatchCoordinationStep).not.toHaveBeenCalled();
    expect(cancelTasksStep).toHaveBeenCalledWith(expect.objectContaining({ turnCalls: false }));
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
      { deliveryId: "cancel-delivery", kind: "cancel" },
    ];
    const inbox: SessionInbox = {
      ...idleInbox(),
      next: vi.fn(async () => payloads.shift()),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: ["hold-call"] }),
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockImplementation(
        dispatchWork(async () => ({ results: [], serializedContext: {}, sessionState })),
      );
    const execution = createExecution({ inbox, sessionState });

    await expect(
      execution.runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Hold the release." }] },
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(settleCancelledTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ control: { deliveryId: "cancel-delivery" } }),
    );

    // No call is open to own it, so the spend is the task's own late usage.
    expect(committed).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "delegated-late",
          usage: expect.objectContaining({ inputTokens: 250, outputTokens: 25 }),
        }),
        type: "usage.recorded",
      }),
    );
  });

  it("applies the run messages read together while the turn waits in one step, in order", async () => {
    const sessionState = state("");
    const from = (taskId?: string): WorkflowToolRunRef => ({
      callId: "triage-call",
      input: {},
      runId: "triage-run",
      sequence: 0,
      stepIndex: 0,
      ...(taskId !== undefined && { taskId }),
      toolName: "triage_issues",
      turnId: "turn_0",
    });
    const opened = (sessionId: string): SessionInboxPayload => ({
      context: { parent: { sessionId: sessionState.sessionId } } as AgentSessionContext,
      from: from(),
      kind: "agent-started",
      session: {
        continuationToken: `subagent:${sessionId}`,
        kind: "local",
        name: "reviewer",
        nodeId: "reviewer",
        sessionId,
      },
    });
    // Alice's triage opens two reviewers and reports, then Bob cancels the turn.
    const payloads: SessionInboxPayload[] = [
      opened("child-1"),
      opened("child-2"),
      { from: from(), kind: "report", update: "Two reviewers started." },
      { deliveryId: "cancel-delivery", kind: "cancel" },
    ];
    const inbox: SessionInbox = {
      ...idleInbox(),
      takeLeading: <T extends SessionInboxPayload>(
        accepts: (payload: SessionInboxPayload) => payload is T,
      ): T[] => {
        const taken: T[] = [];
        for (let next = payloads[0]; next !== undefined && accepts(next); next = payloads[0]) {
          taken.push(next);
          payloads.shift();
        }
        return taken;
      },
      hasPending: vi.fn(() => payloads.length > 0),
      next: vi.fn(async () => payloads.shift()),
    };
    const cursor = createCursor({ inbox, sessionState });
    publishIntoContext();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: ["triage-call"] }),
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
      createExecution({ cursor, inbox, sessionState }).runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Triage the open issues." }] },
      }),
    ).resolves.toEqual({ kind: "expired" });
    expect(settleCancelledTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ control: { deliveryId: "cancel-delivery" } }),
    );

    expect(cursor.serializedContext[PUBLISHED]).toEqual(["child-1+child-2+Two reviewers started."]);
  });

  it("applies reports the turn already admitted before those still in the inbox, and stops at the outcome", async () => {
    const sessionState = stateWithBlockingRun();
    const from: WorkflowToolRunRef = {
      callId: "hold-call",
      input: {},
      runId: "hold-run",
      sequence: 0,
      stepIndex: 0,
      toolName: "hold",
      turnId: "turn_0",
    };
    const report = (update: string): SessionInboxPayload => ({ from, kind: "report", update });
    // Alice's run reported twice while the model step ran, then once more and finished.
    const pending: SessionInboxPayload[] = [
      report("Third check passed."),
      { from, kind: "outcome", result: { output: "held", status: "completed" } },
    ];
    const inbox: SessionInbox = {
      ...idleInbox(),
      takeLeading: <T extends SessionInboxPayload>(
        accepts: (payload: SessionInboxPayload) => payload is T,
      ): T[] => {
        const taken: T[] = [];
        for (let next = pending[0]; next !== undefined && accepts(next); next = pending[0]) {
          taken.push(next);
          pending.shift();
        }
        return taken;
      },
      drain: vi
        .fn()
        .mockReturnValueOnce([report("First check passed."), report("Second check passed.")])
        .mockReturnValue([]),
      hasPending: vi.fn(() => pending.length > 0),
      next: vi.fn(async () => pending.shift() ?? new Promise<never>(() => {})),
    };
    const cursor = createCursor({ inbox, sessionState });
    publishIntoContext();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: ["hold-call"] }),
          serializedContext: {},
          sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async (input) => ({
          action: "done",
          output: "done",
          serializedContext: input.serializedContext,
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep)
      .mockReset()
      .mockImplementation(
        dispatchWork(async () => ({ results: [], serializedContext: {}, sessionState })),
      );

    await expect(
      createExecution({ cursor, inbox, sessionState }).runSession({
        delivery: {
          kind: "deliver",
          payloads: [{ message: "Hold the rollout until checks pass." }],
        },
      }),
    ).resolves.toMatchObject({ kind: "done" });

    expect(cursor.serializedContext[PUBLISHED]).toEqual([
      "First check passed.+Second check passed.+Third check passed.",
    ]);
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input?.runtimeResults?.results).toEqual([
      expect.objectContaining({ callId: "hold-call" }),
    ]);
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
      ...idleInbox(),
      next: vi.fn(async () => payloads.shift() ?? new Promise<never>(() => {})),
    };
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: tools.map((name) => `${name}-call`) }),
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
      createExecution({ inbox, sessionState }).runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Draft the plan and review it." }] },
      }),
    ).resolves.toMatchObject({ kind: "done" });

    // Each call owns what its run spent.
    expect(vi.mocked(turnStep).mock.calls[1]?.[0].input?.runtimeResults?.delegatedUsage).toEqual({
      "draft-call": spent(300),
      "review-call": spent(500),
    });
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
      ...idleInbox(),
      // The pump signals a delivery as it arrives, then the wait reads it.
      next: vi.fn(async () => {
        signalDelivery(steering);
        return steering;
      }),
      onDelivery: vi.fn((handler) => {
        signalDelivery = handler;
        return () => {};
      }),
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
          ...callsPause({
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
      createExecution({ inbox, sessionState }).runSession({
        delivery: { kind: "deliver", payloads: [{ message: "Wait for the research." }] },
      }),
    ).resolves.toMatchObject({ kind: "done" });

    expect(continuation).toEqual({ delivery: steering, steered: false });
  });

  it("publishes and adopts consecutive boundary run messages in one step, keeping admission order", async () => {
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
      createExecution({ cursor, inbox, sessionState: cursor.sessionState }).runSession(undefined),
    ).resolves.toEqual({ kind: "expired" });

    expect(cursor.serializedContext[PUBLISHED]).toEqual([
      "planner-session+reviewer-session+Halfway through the sources.+writer-session",
    ]);
  });

  it("applies nothing its runs reported once the step ended the session", async () => {
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
      createExecution({ cursor, inbox, sessionState }).runSession(undefined),
    ).resolves.toMatchObject({ kind: "done" });

    // Nothing follows `session.ended`: neither the child nor the task's report publishes.
    expect(cursor.serializedContext[PUBLISHED]).toBeUndefined();
  });

  it("announces a child opened before a cancel ahead of cancelling the turn's work", async () => {
    const { inbox, planner } = boundaryRunMessages();
    const sessionState = stateWithBlockingRun();
    let interrupt: (payload: SessionInboxPayload) => void = () => {};
    inbox.onInterrupt = (handler) => {
      interrupt = handler;
      return () => {};
    };
    // Bob cancels while the turn waits, just as Alice's run opens a planner. The pump signals the
    // cancel at once, and it stays in the inbox, behind the planner, for the turn to read.
    const cancel = { deliveryId: "cancel-delivery", kind: "cancel" } as const;
    const arrived: SessionInboxPayload[] = [planner, cancel];
    inbox.next = vi.fn(async () => {
      interrupt(cancel);
      return arrived.shift();
    });
    publishIntoContext();
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async () => ({
          action: "paused",
          ...callsPause({ callIds: ["hold-call"] }),
          serializedContext: {},
          sessionState,
        })),
      );
    vi.mocked(dispatchCoordinationStep).mockImplementation(
      dispatchWork(async () => ({ results: [], serializedContext: {}, sessionState })),
    );

    // The turn stops on the cancel it reads, which is the turn's cause, not a cancel that came
    // after it and found nothing to stop.
    await expect(createExecution({ inbox, sessionState }).runSession(undefined)).resolves.toEqual({
      kind: "expired",
    });
    expect(settleCancelledTurnStep).toHaveBeenCalledWith(
      expect.objectContaining({ control: { deliveryId: "cancel-delivery" } }),
    );

    const [announced] = vi.mocked(applyRunMessagesStep).mock.invocationCallOrder;
    const [cancelled] = vi.mocked(cancelTasksStep).mock.invocationCallOrder;
    expect(announced).toBeLessThan(cancelled!);
  });
});

describe("SessionLoop between turns", () => {
  it.each([
    { at: "boundary", owner: "previous-run" },
    { at: "boundary", owner: "owner-run" },
    { at: "inbox", owner: "previous-run" },
    { at: "inbox", owner: "owner-run" },
  ])("accepts only this owner's timeout ($at, $owner)", async ({ at, owner }) => {
    const sessionState = state("");
    const timeout: SessionInboxPayload = { kind: "session-timeout", ownerRunId: owner };
    const followUp: SessionInboxPayload = {
      kind: "deliver",
      payloads: [{ message: "Bob follows up." }],
    };
    const payloads = at === "inbox" ? [timeout, followUp] : [followUp];
    const inbox = idleInbox();
    if (at === "boundary") inbox.drain = vi.fn().mockReturnValueOnce([timeout]).mockReturnValue([]);
    inbox.next = vi.fn(async () => payloads.shift());
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "parked",
          serializedContext: {},
          sessionState,
        })),
      )
      .mockImplementationOnce(
        turnStepWork(async () => ({
          action: "done",
          serializedContext: {},
          sessionState,
        })),
      );
    const ended = await createExecution({ inbox, sessionState }).runSession(undefined);
    expect(ended.kind).toBe(owner === "owner-run" ? "expired" : "done");
    expect(turnStep).toHaveBeenCalledTimes(owner === "owner-run" ? 1 : 2);
  });

  it("carries the state a fully routed delivery leaves into routing the next one", async () => {
    const sessionState = { ...state(""), hasProxyInputRequests: true };
    const retired = { ...sessionState, hasProxyInputRequests: false };
    const messages: SessionInboxPayload[] = [
      { kind: "send", payload: { message: "child response" } },
      { kind: "send", payload: { message: "parent turn" } },
    ];
    const inbox: SessionInbox = {
      ...idleInbox(),
      hasPending: () => messages.length > 0,
      next: vi.fn(async () => messages.shift()),
    };
    vi.mocked(routeDeliverToChildren)
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: undefined,
        stateDelta: { sessionState: { kind: "value", value: retired } },
      })
      .mockResolvedValueOnce({
        kind: "continue",
        remainder: { kind: "deliver", payloads: [{ message: "parent turn" }] },
        stateDelta: {},
      });
    vi.mocked(turnStep)
      .mockReset()
      .mockImplementation(
        turnStepWork(async (input) => ({
          action: "done",
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        })),
      );
    const loop = new SessionLoop({
      admittedDeliveryKeys: [],
      cursor: createCursor({ inbox, sessionState }),
      inbox,
      sessionId: sessionState.sessionId,
      ownerRunId: "owner-run",
      start: { kind: "parked" },
    });

    await expect(loop.run()).resolves.toMatchObject({ kind: "done" });

    expect(vi.mocked(routeDeliverToChildren).mock.calls[1]?.[0].sessionState).toBe(retired);
    expect(vi.mocked(turnStep).mock.calls[0]?.[0].input).toEqual({
      delivery: { kind: "deliver", payloads: [{ message: "parent turn" }] },
    });
  });
});

/** The context key the mocked publishing steps append to, as a hook's state write would. */
const PUBLISHED = "test.published";

/** Mocks the run-message publishing steps to record what they publish in the session context. */
function publishIntoContext(): void {
  const append = (context: Record<string, unknown>, entry: string) => ({
    cancelled: false,
    serializedContext: {
      ...context,
      [PUBLISHED]: [...((context[PUBLISHED] as string[] | undefined) ?? []), entry],
    },
  });
  vi.mocked(applyRunMessagesStep)
    .mockReset()
    .mockImplementation(
      stepWork(async (input: Parameters<typeof applyRunMessagesStep>[0]) =>
        append(
          input.serializedContext,
          input.messages
            .map((message) =>
              message.kind === "agent-started"
                ? message.session.sessionId
                : message.kind === "report"
                  ? String(message.update)
                  : message.kind,
            )
            .join("+"),
        ),
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
    context: { parent: { sessionId: "parent" } } as AgentSessionContext,
    from: from(callId),
    kind: "agent-started",
    session: {
      continuationToken: `subagent:${name}`,
      kind: "local",
      name,
      nodeId: name,
      sessionId: `${name}-session`,
    },
  });
  const inbox: SessionInbox = {
    ...idleInbox(),
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
    takeLeading: () => [],
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

/**
 * A session the test starts with a turn. `runSession` runs it until it ends: once its inbox has
 * nothing left to read, it closes, and the session expires.
 */
function createExecution(input: {
  readonly admittedDeliveryKeys?: readonly string[];
  readonly capabilities?: SessionCapabilities;
  readonly cursor?: SessionStateCursor;
  readonly handoff?: SessionLoopInput["handoff"];
  readonly inbox: SessionInbox;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}) {
  const cursor = input.cursor ?? createCursor(input);
  return {
    cursor,
    runSession: (
      turn: TurnStepPayload | undefined,
      options: { readonly caller?: TurnCaller; readonly control?: TurnControl } = {},
    ) =>
      new SessionLoop({
        admittedDeliveryKeys: input.admittedDeliveryKeys ?? [],
        caller: options.caller,
        capabilities: input.capabilities,
        cursor,
        handoff: input.handoff,
        inbox: input.inbox,
        sessionId: input.sessionState.sessionId,
        ownerRunId: "owner-run",
        start: { input: turn?.delivery, kind: "turn" },
      }).run({ control: options.control }),
  };
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
function callsPause(input: {
  readonly callIds: readonly string[];
  readonly dispatch?: boolean;
  readonly taskToolCalls?: Extract<TurnPause, { on: "calls" }>["taskToolCalls"];
}): TurnPause {
  return {
    callIds: input.callIds,
    dispatch: input.dispatch ?? true,
    on: "calls",
    taskToolCalls: input.taskToolCalls ?? [],
  };
}
