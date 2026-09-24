import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import type { TokenUsage } from "#shared/token-usage.js";
import {
  bindTurnCallerContextStep,
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  reportRefusedCallerReplyStep,
  resolveInitialTurnCallerStep,
  type SettledTurnNotification,
} from "#tasks/child.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { getHarnessEmissionState } from "#harness/emission-state.js";
import { answerOrder, reportOrdering } from "#tasks/protocol.js";
import {
  hasOpenTurnWork,
  nextTurnDelivery,
  type NextTurnInstruction,
} from "#execution/session/next-input.js";
import { cancelTasks, closeTaskOwnerInbox, syncTaskTimer } from "#tasks/owner-body.js";
import { workingTaskIds } from "#tasks/results.js";
import { flushUnsentCallerEvents } from "#subagents/remote/unsent-caller-events.js";
import {
  readAdmittedOperations,
  SessionInputQueue,
  withAdmittedOperations,
} from "#execution/session/input-queue.js";
import { SessionExecution, sessionPrincipal } from "#execution/session/turn.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/session/turn-step-types.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  finalizeSession,
  type FinalizedSession,
  type SessionTerminalOutcome,
} from "#execution/session/finalization.js";
import { type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { createSessionTimeoutControl } from "#execution/session/timeout-control.js";
import { SessionHandoff, sessionAnchorToken } from "#execution/session/handoff.js";
import { signalSessionAnchorStep } from "#execution/session/handoff-steps.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";

/** The run's own failure never carries internals; the terminal event already logged them. */
function createSafeOuterWorkflowError(): Error {
  const error = new Error("Agent workflow failed. Inspect the private session trace for details.");
  error.name = "EveWorkflowFailure";
  return error;
}

/**
 * Who to tell when this owner exits. The original run anchors the public
 * stream itself; a successor signals the original run. A `self` anchor may
 * also name a `notify` step that runs with the final result, which lets an
 * importer settle whatever predecessor still holds the stream open.
 */
export type SessionAnchor =
  | {
      readonly kind: "self";
      readonly notify?: (result: WorkflowEntryResult) => Promise<void>;
    }
  | { readonly kind: "successor" };

export interface SessionBoot {
  readonly anchor: SessionAnchor;
  readonly caller: TurnCaller | undefined;
  /**
   * The context is already bound to `caller`, because the boot resolved that
   * local caller from it, so the first turn skips rebinding.
   */
  readonly callerBound?: boolean;
  readonly capabilities?: SessionCapabilities;
  readonly deploymentId: string;
  readonly initialInput: DeliverHookPayload | undefined;
  /** Parks on the inbox before any session-scoped lifecycle work. */
  readonly awaitFirstMessage: boolean;
  readonly mode: RunMode;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
  readonly sessionTimeoutMs: number | false;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

type SessionLoopOutcome =
  | { readonly kind: "terminal"; readonly outcome: SessionTerminalOutcome }
  | { readonly kind: "transferred" };

type SessionActionResult =
  | { readonly action: TurnOutcome; readonly kind: "action" }
  | SessionLoopOutcome;

/** Mutable facts the crash path needs that do not live in the state cursor. */
interface SessionProgress {
  /** Delegated caller whose awaited reply is still unsettled. */
  caller: TurnCaller | undefined;
  terminalEmitted: boolean;
  /** Last dispatched turn; a crash between turns is attributed to it. */
  turnId?: string;
}

/** Runs an already prepared owner against its session's existing stream. */
export async function runPreparedSession(
  boot: SessionBoot,
  inbox: SessionInboxHandle,
): Promise<WorkflowEntryResult> {
  const cursor = new SessionStateCursor({
    inbox,
    sessionWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
  });
  const progress: SessionProgress = { caller: boot.caller, terminalEmitted: false };
  const handoff = new SessionHandoff({
    checkpoint: {
      capabilities: boot.capabilities,
      mode: boot.mode,
      retention: boot.retention,
      sessionTimeoutMs: boot.sessionTimeoutMs,
    },
    deploymentId: boot.deploymentId,
    inbox,
    isInitialOwner: boot.anchor.kind === "self",
    sessionId: boot.sessionId,
  });
  let result: WorkflowEntryResult = { output: "", isError: true };
  let loop: SessionLoopOutcome | undefined;
  try {
    try {
      loop = await runSessionLoop(boot, { cursor, handoff, inbox, progress });
    } finally {
      if (loop?.kind !== "terminal") await inbox.dispose();
    }
    if (loop.kind === "transferred") {
      if (boot.anchor.kind !== "self") return { output: "" };
      result = await handoff.awaitAnchoredResult();
      return result;
    }
    // Closed before anything else runs: nothing below may reopen an address.
    await closeTaskOwnerInbox(cursor, inbox);
    // Session end cancels every working task; nothing is delivered afterwards.
    await cancelTasks(cursor, { kind: "all" });
    const finalized = await finalizeSession(loop.outcome, {
      caller: progress.caller,
      cursor,
      mode: boot.mode,
      sessionWritable: boot.sessionWritable,
    });
    result = finalized.result;
    await replyTerminal(finalized, { caller: progress.caller, cursor, sessionId: boot.sessionId });
    progress.terminalEmitted = true;
    return result;
  } catch (error) {
    if (!progress.terminalEmitted) {
      try {
        // A failed session ends its tasks too, so its caller's reply follows them.
        await cancelTasks(cursor, { kind: "all" });
      } catch {
        // Best effort: the failure is already being reported.
      }
      const finalized = await finalizeSession(
        { error, kind: "failed", turnId: progress.turnId },
        { caller: progress.caller, cursor, mode: boot.mode, sessionWritable: boot.sessionWritable },
      );
      await replyTerminal(finalized, {
        caller: progress.caller,
        cursor,
        sessionId: boot.sessionId,
      });
    }
    throw createSafeOuterWorkflowError();
  } finally {
    await reportResultToAnchor(boot, result, handoff, loop);
  }
}

/**
 * Terminal path for a boot that failed before the session loop could run.
 * The caller is re-resolved from context because no turn ever bound it.
 */
export async function failSession(input: {
  readonly error: unknown;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<never> {
  let caller: TurnCaller | undefined;
  try {
    caller = await resolveInitialTurnCallerStep({ serializedContext: input.serializedContext });
  } catch {
    // Best effort: when resolution fails again there is no reachable caller to notify.
  }
  const cursor = { serializedContext: input.serializedContext, sessionState: input.sessionState };
  const finalized = await finalizeSession(
    { error: input.error, kind: "failed" },
    { caller, cursor, mode: input.mode, sessionWritable: input.sessionWritable },
  );
  await replyTerminal(finalized, { caller, cursor, sessionId: input.sessionId });
  throw createSafeOuterWorkflowError();
}

/** What a delegated caller learns: its turn's answer, or that the call was cancelled. */
type CallerReply =
  | {
      readonly kind: "settled";
      readonly lifecycle: AgentTurnOutcome["kind"];
      readonly settled: SettledTurnNotification;
    }
  | { readonly kind: "cancelled"; readonly usage?: TokenUsage };

interface CallerReplyTarget {
  readonly caller: TurnCaller | undefined;
  readonly cursor: {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState | undefined;
  };
  readonly sessionId: string;
}

/**
 * The one place this session settles a delegated caller (guard rule 50). A
 * reply follows the settlement of its turn's tasks (the turn rule), so a
 * reply while tasks the turn started still work is a bug: it is refused and
 * reported instead of settling the caller early.
 */
export async function replyToCaller(
  target: CallerReplyTarget & { readonly reply: CallerReply },
): Promise<void> {
  const { caller, reply, sessionId } = target;
  if (caller === undefined) return;
  const working = workingTaskIds(
    { state: target.cursor.sessionState?.snapshot.session.state },
    sessionPrincipal(target.cursor.serializedContext),
  );
  if (working.length > 0) {
    await reportRefusedCallerReplyStep({ callId: caller.callId, sessionId, taskIds: working });
    return;
  }
  if (reply.kind === "cancelled") {
    await notifyCancelledTaskCallerStep(
      reply.usage === undefined ? { caller, sessionId } : { caller, sessionId, usage: reply.usage },
    );
    return;
  }
  await notifyTurnCallerStep({
    caller,
    lifecycle: reply.lifecycle,
    sessionId,
    settled: reply.settled,
  });
}

/** Sends the parked caller the terminal answer a finished session owes it. */
async function replyTerminal(finalized: FinalizedSession, target: CallerReplyTarget) {
  if (finalized.callerReply === undefined) return;
  await replyToCaller({
    ...target,
    reply: { kind: "settled", lifecycle: "terminal", settled: finalized.callerReply },
  });
}

async function reportResultToAnchor(
  boot: SessionBoot,
  result: WorkflowEntryResult,
  handoff: SessionHandoff,
  loop: SessionLoopOutcome | undefined,
): Promise<void> {
  switch (boot.anchor.kind) {
    case "self":
      await handoff.disposeAnchor();
      await boot.anchor.notify?.(result);
      return;
    case "successor":
      if (loop?.kind === "transferred") return;
      await signalSessionAnchorStep({ result, token: sessionAnchorToken(boot.sessionId) });
      return;
  }
}

async function runSessionLoop(
  boot: SessionBoot,
  deps: {
    readonly cursor: SessionStateCursor;
    readonly handoff: SessionHandoff;
    readonly inbox: SessionInboxHandle;
    readonly progress: SessionProgress;
  },
): Promise<SessionLoopOutcome> {
  const { cursor, handoff, inbox, progress } = deps;
  const queue = new SessionInputQueue({
    admittedOperations: readAdmittedOperations(cursor.sessionState.snapshot.session.state),
  });
  const execution = new SessionExecution({
    capabilities: boot.capabilities,
    cursor,
    inbox,
    mode: boot.mode,
    queue,
    sessionId: boot.sessionId,
  });
  const sessionTimeout =
    boot.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: boot.sessionTimeoutDeadline,
          sessionId: boot.sessionId,
        });

  const nextParkedActivity = async (
    expectedAttemptIds: ReadonlySet<string>,
  ): Promise<Exclude<NextTurnInstruction, { kind: "workflow" }>> => {
    while (true) {
      // A remote caller must see this session's questions before it waits on them.
      await flushUnsentCallerEvents(cursor);
      const next = await nextTurnDelivery({
        cursor,
        // A task-mode run takes no follow-up input while it waits for an authorization.
        deferDeliveries: boot.mode === "task" && expectedAttemptIds.size > 0,
        expectedAttemptIds,
        inbox,
        // A caller whose turn parked on an approval is still owed its
        // result, so a cancel settles the caller.
        ownsParkedWork: () => progress.caller !== undefined,
        queue,
      });
      if (next.kind !== "workflow") return next;
      await execution.handleWorkflowMessage(next.message);
    }
  };

  let turnIndex = 0;
  let boundCaller = boot.callerBound === true ? boot.caller : undefined;
  const runTurn = async (payload: TurnStepPayload | undefined): Promise<TurnOutcome> => {
    const caller = progress.caller;
    const bound = caller !== undefined && caller === boundCaller;
    boundCaller = undefined;
    if (caller !== undefined && !bound) {
      await cursor.apply({
        serializedContext: await bindTurnCallerContextStep({
          caller,
          serializedContext: cursor.serializedContext,
        }),
      });
    }
    progress.turnId = `turn_${String(turnIndex++)}`;
    // The owner steers the call this session is answering, including in the
    // first turn, whose input carries no caller.
    return await execution.runTurn(payload, caller?.callId);
  };
  const runDeliveredTurn = async (
    next: Extract<NextTurnInstruction, { kind: "turn" }>,
  ): Promise<SessionActionResult> => {
    const transfer = await handoff.tryTransfer(next, {
      serializedContext: cursor.serializedContext,
      // The successor keeps dropping resent deliveries this session admitted.
      sessionState: withAdmittedOperations(cursor.sessionState, queue.admittedOperations()),
    });
    if (transfer.kind === "transferred") return transfer;
    if (next.delivery.caller !== undefined) progress.caller = next.delivery.caller;
    return { action: await runTurn({ delivery: next.delivery }), kind: "action" };
  };
  const settleCancelledTurn = async () => {
    const settled = await settleCancelledTurnStep({
      sessionWritable: boot.sessionWritable,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
    await cursor.apply(settled);
    return settled;
  };
  const awaitPrewarmedAction = async (): Promise<SessionActionResult> => {
    while (true) {
      const next = await nextParkedActivity(new Set());
      switch (next.kind) {
        case "expired":
        case "reset":
        case "closed":
          return { kind: "terminal", outcome: { kind: "expired" } };
        case "clear":
        case "compact":
          continue;
        case "turn":
          return await runDeliveredTurn(next);
        case "cancel-turn":
        case "cancel-parked":
        case "authorization-resume":
          continue;
      }
    }
  };
  const runInitialAction = async (): Promise<SessionActionResult> => {
    if (boot.awaitFirstMessage) return await awaitPrewarmedAction();
    const action = await runTurn(
      boot.initialInput === undefined ? undefined : { delivery: boot.initialInput },
    );
    return { action, kind: "action" };
  };

  try {
    // A successor inherits the task table but re-arms the timer: the one its
    // predecessor armed may retire with the old deployment.
    await syncTaskTimer(cursor);
    const [actionResult, timerResult] = await Promise.allSettled([
      runInitialAction(),
      sessionTimeout?.start(),
    ]);
    if (timerResult.status === "rejected") throw timerResult.reason;
    if (actionResult.status === "rejected") throw actionResult.reason;
    const initial = actionResult.value;
    if (initial.kind !== "action") return initial;
    let action = initial.action;

    while (true) {
      if (action.kind === "done") {
        return { kind: "terminal", outcome: { action, kind: "done" } };
      }

      if (action.cancelled === true) {
        // The turn already cancelled every working task.
        const caller = progress.caller;
        if (caller !== undefined) queue.discardSteering(caller.callId);
        const settled = await settleCancelledTurn();
        // An expired session ends now, and its caller learns the session ended.
        if (action.expired === true) return { kind: "terminal", outcome: { kind: "expired" } };
        progress.caller = undefined;
        await replyToCaller({
          caller,
          cursor,
          reply: { kind: "cancelled", usage: settled.usage },
          sessionId: boot.sessionId,
        });
      } else if (
        action.settled !== undefined &&
        // A message the owner sent this working agent as its turn ended joins
        // the same call, so the reply that settles it has seen the message.
        // One that arrives after the reply starts the call's next turn.
        !(
          progress.caller !== undefined &&
          queue.hasSteeringMessage({
            callerCallId: progress.caller.callId,
            principal: sessionPrincipal(cursor.serializedContext),
          })
        )
      ) {
        if (progress.caller !== undefined) {
          const steers = queue.takeSteerCount(progress.caller.callId);
          await replyToCaller({
            caller: progress.caller,
            cursor,
            reply: {
              kind: "settled",
              lifecycle: "parked",
              settled: {
                ...action.settled,
                ...reportOrdering(
                  steers,
                  answerOrder(
                    getHarnessEmissionState(cursor.sessionState.snapshot.session.state).sequence,
                    "parked",
                  ),
                ),
              },
            },
            sessionId: boot.sessionId,
          });
        }
        progress.caller = undefined;
      }

      // An open authorization challenge must not wedge the session:
      // ordinary deliveries keep starting normal turns while the challenge
      // waits for its callback. The pending challenge survives intervening
      // turns because every park re-derives `authorizationAttemptIds` from
      // durable session state.
      const next = await nextParkedActivity(new Set(action.authorizationAttemptIds ?? []));

      switch (next.kind) {
        case "authorization-resume":
          action = await runTurn({ delivery: { kind: "deliver", payloads: next.payloads } });
          continue;
        case "expired":
        case "reset":
        case "closed":
          return { kind: "terminal", outcome: { kind: "expired" } };
        case "clear":
        case "compact":
          action = await runTurn({ control: next.kind });
          continue;
        case "cancel-turn":
        case "cancel-parked": {
          const caller = progress.caller;
          // Only a turn parked mid-way has an open turn to settle; a turn that
          // ended while its caller's steering message waited already did.
          const turnOpen =
            next.kind === "cancel-turn" ||
            hasOpenTurnWork(cursor.sessionState.snapshot.session.state);
          await cancelTasks(cursor, { kind: "all" });
          if (caller !== undefined) queue.discardSteering(caller.callId);
          const usage = turnOpen ? (await settleCancelledTurn()).usage : action.settled?.usage;
          progress.caller = undefined;
          // The caller learns the call was cancelled; the prior turn is never reported.
          await replyToCaller({
            caller,
            cursor,
            reply: { kind: "cancelled", usage },
            sessionId: boot.sessionId,
          });
          action = { ...action, settled: undefined };
          continue;
        }
        case "turn": {
          const result = await runDeliveredTurn(next);
          if (result.kind !== "action") return result;
          action = result.action;
          continue;
        }
      }
    }
  } finally {
    await sessionTimeout?.dispose();
  }
}
