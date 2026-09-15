import type { DeliverPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import { createSafeOuterWorkflowError } from "#execution/workflow-entry-crash.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import type { RunMode } from "#shared/run-mode.js";
import {
  bindTurnCallerContextStep,
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { nextTurnDelivery, type NextTurnInstruction } from "#execution/parked-delivery-wait.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { SessionInputLedger } from "#execution/session-input-ledger.js";
import { SessionInputQueue } from "#execution/session-input-queue.js";
import { SessionExecution } from "#execution/session-execution.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/turn-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { finalizeSession, type SessionTerminalOutcome } from "#execution/session-finalization.js";
import { type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { SessionHandoff, sessionAnchorToken } from "#execution/session-handoff.js";
import { signalSessionAnchorStep } from "#execution/session-handoff-steps.js";
import type { WorkflowEntryResult } from "#execution/workflow-entry-input.js";

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
  readonly capabilities?: SessionCapabilities;
  readonly deploymentId: string;
  readonly initialInput: TurnStepPayload | undefined;
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
    parentWritable: boot.sessionWritable,
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
  try {
    let loop: SessionLoopOutcome;
    try {
      loop = await runSessionLoop(boot, { cursor, handoff, inbox, progress });
    } finally {
      await inbox.dispose();
    }
    if (loop.kind === "transferred") {
      if (boot.anchor.kind !== "self") return { output: "" };
      result = await handoff.awaitAnchoredResult();
      return result;
    }
    result = await finalizeSession(loop.outcome, {
      caller: progress.caller,
      cursor,
      mode: boot.mode,
      sessionWritable: boot.sessionWritable,
    });
    progress.terminalEmitted = true;
    return result;
  } catch (error) {
    if (!progress.terminalEmitted) {
      await finalizeSession(
        { error, kind: "failed", turnId: progress.turnId },
        { caller: progress.caller, cursor, mode: boot.mode, sessionWritable: boot.sessionWritable },
      );
    }
    throw createSafeOuterWorkflowError();
  } finally {
    await reportResultToAnchor(boot, result, handoff);
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
  await finalizeSession(
    { error: input.error, kind: "failed" },
    {
      caller,
      cursor: {
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      },
      mode: input.mode,
      sessionWritable: input.sessionWritable,
    },
  );
  throw createSafeOuterWorkflowError();
}

async function reportResultToAnchor(
  boot: SessionBoot,
  result: WorkflowEntryResult,
  handoff: SessionHandoff,
): Promise<void> {
  switch (boot.anchor.kind) {
    case "self":
      await handoff.disposeAnchor();
      await boot.anchor.notify?.(result);
      return;
    case "successor":
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
  const queue = new SessionInputQueue();
  const ledger = new SessionInputLedger();
  const execution = new SessionExecution({
    capabilities: boot.capabilities,
    cursor,
    inbox,
    ledger,
    mode: boot.mode,
    queue,
    sessionId: boot.sessionId,
  });
  // One payload per exact authorization attempt accumulates across
  // intervening turns. Replaced attempts are pruned at each park.
  const collectedAuthPayloads = new Map<string, DeliverPayload>();
  const sessionTimeout =
    boot.sessionTimeoutDeadline === undefined
      ? undefined
      : createSessionTimeoutControl({
          deadline: boot.sessionTimeoutDeadline,
          sessionId: boot.sessionId,
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
        cursor,
        deferDeliveries: boot.mode === "task" && expectedAttemptIds.size > 0,
        inbox,
        ledger,
        queue,
      });
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
    const caller = progress.caller;
    if (caller?.taskId !== undefined) ledger.rememberTask(caller.taskId);
    if (caller !== undefined) {
      await cursor.apply({
        serializedContext: await bindTurnCallerContextStep({
          caller,
          serializedContext: cursor.serializedContext,
        }),
      });
    }
    progress.turnId = `turn_${String(turnIndex++)}`;
    return await execution.runTurn(delivery);
  };
  const settleCancelledTurn = async () => {
    const settled = await settleCancelledTurnStep({
      parentWritable: boot.sessionWritable,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
    await cursor.apply(settled);
    progress.caller = undefined;
    return settled;
  };

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
        return { kind: "terminal", outcome: { action, kind: "done" } };
      }

      if (action.cancelled === true) {
        const cancelledCaller = { caller: progress.caller, sessionId: boot.sessionId };
        const settled = await settleCancelledTurn();
        await notifyCancelledTaskCallerStep(
          settled.usage === undefined
            ? cancelledCaller
            : { ...cancelledCaller, usage: settled.usage },
        );
      } else if (action.settled !== undefined) {
        if (progress.caller !== undefined) {
          await notifyTurnCallerStep({
            caller: progress.caller,
            lifecycle: "parked",
            sessionId: boot.sessionId,
            settled: action.settled,
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
          action = await runTurn({ kind: "deliver", payloads: next.payloads });
          continue;
        case "expired":
        case "reset":
        case "closed":
          return { kind: "terminal", outcome: { kind: "expired" } };
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
            serializedContext: cursor.serializedContext,
            sessionState: cursor.sessionState,
          });
          if (transfer.kind === "transferred") return { kind: "transferred" };
          if (next.delivery.caller !== undefined) progress.caller = next.delivery.caller;
          action = await runTurn(next.delivery);
          continue;
        }
      }
    }
  } finally {
    await sessionTimeout?.dispose();
  }
}
