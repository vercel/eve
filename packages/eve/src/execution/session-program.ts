import type { DeliverPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import {
  createSafeOuterWorkflowError,
  type CrashCleanupState,
  resolveCallerForCrash,
} from "#execution/workflow-entry-crash.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";
import {
  bindTurnCallerContextStep,
  notifyCancelledTaskCallerStep,
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
} from "#subagents/parent-notification.js";
import { createDelegatedSubagentErrorResult } from "#subagents/parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { nextTurnDelivery, type NextTurnInstruction } from "#execution/parked-delivery-wait.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { SessionInputLedger } from "#execution/session-input-ledger.js";
import { SessionInputQueue } from "#execution/session-input-queue.js";
import { SessionExecution } from "#execution/session-execution.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/turn-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#subagents/callback-step.js";
import { finalizeDone, finalizeExpiredSession } from "#execution/workflow-entry-finalization.js";
import { type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { SessionHandoff, type SessionOwnership } from "#execution/session-handoff.js";
import { signalSessionAnchorStep } from "#execution/session-handoff-steps.js";
import type { WorkflowEntryResult } from "#execution/workflow-entry-input.js";

export interface SessionBoot {
  readonly anchorToken: string;
  readonly capabilities?: SessionCapabilities;
  readonly caller: TurnCaller | undefined;
  readonly initialInput: TurnStepPayload | undefined;
  readonly isInitialOwner: boolean;
  readonly mode: RunMode;
  readonly ownership: SessionOwnership;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutDeadline?: Date;
  readonly sessionTimeoutMs: number | false;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

type SessionLoopOutcome =
  | {
      readonly kind: "expired";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | { readonly kind: "result"; readonly result: WorkflowEntryResult }
  | { readonly kind: "transferred" };

/** Runs an already prepared owner against its session's existing stream. */
export async function runPreparedSession(
  boot: SessionBoot,
  commandInbox: SessionInboxHandle,
): Promise<WorkflowEntryResult> {
  const { serializedContext, sessionWritable, mode } = boot;
  const sessionId = boot.ownership.sessionId;
  const crashCleanupState: CrashCleanupState = {
    caller: boot.caller,
    callerResolved: true,
    lastSessionState: boot.sessionState,
    serializedContext,
    terminalEmitted: false,
  };
  const handoff = new SessionHandoff({ ...boot, commandInbox });
  try {
    let outcome: SessionLoopOutcome;
    try {
      outcome = await runSessionLoop(boot, { commandInbox, crashCleanupState, handoff });
    } finally {
      await commandInbox.dispose();
    }
    if (outcome.kind === "transferred") {
      return boot.isInitialOwner ? await handoff.awaitAnchoredResult() : { output: "" };
    }
    const result =
      outcome.kind === "result"
        ? outcome.result
        : await finalizeExpiredSession({
            caller: crashCleanupState.caller,
            sessionWritable,
            mode,
            serializedContext: outcome.serializedContext,
            sessionState: outcome.sessionState,
            terminalState: crashCleanupState,
          });
    await reportResultToAnchor(boot, result, handoff);
    return result;
  } catch (error) {
    try {
      await failSession({ error, crashCleanupState, sessionWritable, sessionId, mode });
    } finally {
      await reportResultToAnchor(boot, { output: "", isError: true }, handoff);
    }
    throw createSafeOuterWorkflowError();
  }
}

export async function failSession(input: {
  readonly error: unknown;
  readonly crashCleanupState: CrashCleanupState;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly sessionId: string;
  readonly mode: RunMode;
}): Promise<never> {
  const { error, crashCleanupState, sessionWritable, sessionId, mode } = input;
  const terminalAlreadyEmitted = crashCleanupState.terminalEmitted;
  // Safety net for failures the tool-loop harness does not already
  // surface as `session.failed` (deserialization, runtime-action
  // throws, adapter `deliver` throws, staging errors, etc.) so the
  // channel still sees a terminal event.
  if (!crashCleanupState.terminalEmitted && crashCleanupState.lastSessionState !== undefined) {
    await terminateChildSessionsStep({
      serializedContext: crashCleanupState.serializedContext,
      sessionState: crashCleanupState.lastSessionState,
    });
  }
  if (!crashCleanupState.terminalEmitted) {
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(error),
      parentWritable: sessionWritable,
      serializedContext: crashCleanupState.serializedContext,
      turnId: crashCleanupState.turnId,
    });
    crashCleanupState.terminalEmitted = true;
  }
  if (terminalAlreadyEmitted) throw createSafeOuterWorkflowError();
  if (mode === "task") {
    await fireSessionCallbackStep({
      error: normalizeSerializableError(error),
      serializedContext: crashCleanupState.serializedContext,
      status: "failed",
    });
    await notifyDelegatedParentStep({
      result: createDelegatedSubagentErrorResult(crashCleanupState.serializedContext, error),
      serializedContext: crashCleanupState.serializedContext,
    });
  } else if (crashCleanupState.caller !== undefined || !crashCleanupState.callerResolved) {
    await notifyTurnCallerStep({
      caller: await resolveCallerForCrash(crashCleanupState, crashCleanupState.serializedContext),
      lifecycle: "terminal",
      sessionId,
      settled: { isError: true, output: error },
    });
  }

  throw createSafeOuterWorkflowError();
}

async function reportResultToAnchor(
  boot: SessionBoot,
  result: WorkflowEntryResult,
  handoff: SessionHandoff,
): Promise<void> {
  if (boot.isInitialOwner) await handoff.disposeAnchor();
  else await signalSessionAnchorStep({ result, token: boot.anchorToken });
}

async function runSessionLoop(
  boot: SessionBoot,
  deps: {
    readonly commandInbox: SessionInboxHandle;
    readonly crashCleanupState: CrashCleanupState;
    readonly handoff: SessionHandoff;
  },
): Promise<SessionLoopOutcome> {
  const { commandInbox, crashCleanupState, handoff } = deps;
  const cursor = new SessionStateCursor({
    commandInbox,
    parentWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
  });
  const queue = new SessionInputQueue();
  const ledger = new SessionInputLedger();
  const execution = new SessionExecution({
    capabilities: boot.capabilities,
    commandInbox,
    cursor,
    ledger,
    mode: boot.mode,
    queue,
  });
  // One payload per exact authorization attempt accumulates across
  // intervening turns. Replaced attempts are pruned at each park.
  const collectedAuthPayloads = new Map<string, DeliverPayload>();
  const stableCommandToken = commandInbox.hookClaims.stable;
  const sessionTimeout =
    boot.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: boot.sessionTimeoutDeadline,
          token: stableCommandToken,
        });

  /**
   * Waits for the next parked-session activity. While an authorization
   * challenge is open (`expected > 0`), callback reads surface through the
   * same single FIFO wait as ordinary session activity — one arrival order,
   * which keeps the wait deterministic under workflow replay — and keep
   * surfacing across wait iterations that produce no parent turn. Callbacks
   * accumulate across intervening turns; once every expected challenge has
   * reported, the collected payloads resume the challenge.
   */
  const nextParkedActivity = async (
    expectedAttemptIds: ReadonlySet<string>,
  ): Promise<
    | { readonly kind: "authorization-resume"; readonly payloads: DeliverPayload[] }
    | Exclude<NextTurnInstruction, { kind: "authorization" | "workflow" }>
  > => {
    for (const attemptId of collectedAuthPayloads.keys()) {
      if (!expectedAttemptIds.has(attemptId)) collectedAuthPayloads.delete(attemptId);
    }
    while (true) {
      if (
        expectedAttemptIds.size > 0 &&
        [...expectedAttemptIds].every((attemptId) => collectedAuthPayloads.has(attemptId))
      ) {
        const payloads = [...expectedAttemptIds].map((id) => collectedAuthPayloads.get(id)!);
        collectedAuthPayloads.clear();
        return { kind: "authorization-resume", payloads };
      }
      const next = await nextTurnDelivery({
        awaitAuthorizationCallbacks: expectedAttemptIds.size > 0,
        commandInbox,
        cursor,
        deferDeliveries: boot.mode === "task" && expectedAttemptIds.size > 0,
        ledger,
        queue,
      });
      // The previous owner's timer may publish while handoff cancels it.
      // Only this owner's deadline can expire the renewed session.
      if (
        next.kind === "expired" &&
        (boot.sessionTimeoutDeadline === undefined ||
          Date.now() < boot.sessionTimeoutDeadline.getTime())
      )
        continue;
      if (next.kind === "workflow") {
        await execution.handleWorkflowMessage(next.message);
        continue;
      }
      if (next.kind !== "authorization") return next;
      for (const payload of next.payloads) {
        const callback = payload["authorizationCallback"] as
          | { readonly attemptId?: unknown }
          | undefined;
        if (
          typeof callback?.attemptId === "string" &&
          expectedAttemptIds.has(callback.attemptId) &&
          !collectedAuthPayloads.has(callback.attemptId)
        ) {
          collectedAuthPayloads.set(callback.attemptId, payload);
        }
      }
    }
  };

  let turnIndex = 0;
  const runTurn = async (delivery: TurnStepPayload | undefined): Promise<TurnOutcome> => {
    const caller = crashCleanupState.caller;
    if (caller?.taskId !== undefined) ledger.rememberTask(caller.taskId);
    if (caller !== undefined) {
      await cursor.apply({
        serializedContext: await bindTurnCallerContextStep({
          caller,
          serializedContext: cursor.serializedContext,
        }),
      });
    }
    crashCleanupState.turnId = `turn_${String(turnIndex++)}`;
    const outcome = await execution.runTurn(delivery);
    crashCleanupState.lastSessionState = cursor.sessionState;
    crashCleanupState.serializedContext = cursor.serializedContext;
    return outcome;
  };
  const settleCancelledTurn = async () => {
    const settled = await settleCancelledTurnStep({
      parentWritable: boot.sessionWritable,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
    await cursor.apply(settled);
    crashCleanupState.serializedContext = cursor.serializedContext;
    crashCleanupState.lastSessionState = cursor.sessionState;
    crashCleanupState.caller = undefined;
    return settled;
  };
  const finalize = async (): Promise<SessionLoopOutcome> => ({
    kind: "result",
    result: await finalizeExpiredSession({
      caller: crashCleanupState.caller,
      sessionWritable: boot.sessionWritable,
      mode: boot.mode,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
      terminalState: crashCleanupState,
    }),
  });

  try {
    const [actionResult, timerResult] = await Promise.allSettled([
      runTurn(boot.initialInput),
      sessionTimeout?.start(),
    ]);
    if (timerResult.status === "rejected") throw timerResult.reason;
    if (actionResult.status === "rejected") throw actionResult.reason;
    let action: TurnOutcome = actionResult.value;

    while (true) {
      if (action.kind === "done") {
        return {
          kind: "result",
          result: {
            ...(await finalizeDone({
              action,
              caller: crashCleanupState.caller,
              mode: boot.mode,
              serializedContext: cursor.serializedContext,
              sessionState: cursor.sessionState,
              terminalState: crashCleanupState,
            })),
            isError: action.isError,
            usage: action.usage,
            usageDelta: action.usageDelta,
          },
        };
      }

      if (action.cancelled === true) {
        const cancelledCaller = {
          caller: crashCleanupState.caller,
          sessionId: cursor.sessionState.sessionId,
        };
        const settled = await settleCancelledTurn();
        await notifyCancelledTaskCallerStep(
          settled.usage === undefined
            ? cancelledCaller
            : { ...cancelledCaller, usage: settled.usage },
        );
      } else if (action.settled !== undefined) {
        if (crashCleanupState.caller !== undefined) {
          await notifyTurnCallerStep({
            caller: crashCleanupState.caller,
            lifecycle: "parked",
            sessionId: cursor.sessionState.sessionId,
            settled: action.settled,
          });
        }
        crashCleanupState.caller = undefined;
      }

      // An open authorization challenge must not wedge the session:
      // ordinary deliveries keep starting normal turns while the challenge
      // waits for its callback. The pending challenge survives intervening
      // turns because every park re-derives `authorizationAttemptIds` from
      // durable session state.
      const next = await nextParkedActivity(new Set(action.authorizationAttemptIds ?? []));
      crashCleanupState.lastSessionState = cursor.sessionState;

      switch (next.kind) {
        case "authorization-resume":
          action = await runTurn({ kind: "deliver", payloads: next.payloads });
          continue;
        case "expired":
          return {
            kind: "expired",
            serializedContext: cursor.serializedContext,
            sessionState: cursor.sessionState,
          };
        case "reset":
        case "closed":
          return await finalize();
        case "clear":
        case "compact":
          action = await runTurn({ kind: next.kind });
          continue;
        case "cancel-turn":
          await cancelDescendantTurnsStep({
            serializedContext: cursor.serializedContext,
            sessionState: cursor.sessionState,
          });
          await settleCancelledTurn();
          // Re-enter with `settled` cleared: the parked answer was already
          // delivered to its caller before this wait.
          action = { ...action, settled: undefined };
          continue;
        case "turn": {
          const transfer = await handoff.tryTransfer(next, {
            queue,
            serializedContext: cursor.serializedContext,
            sessionState: cursor.sessionState,
          });
          if (transfer.kind === "transferred") return { kind: "transferred" };
          if (next.delivery.caller !== undefined) crashCleanupState.caller = next.delivery.caller;
          action = await runTurn(next.delivery);
          continue;
        }
      }
    }
  } finally {
    await sessionTimeout?.dispose();
  }
}
