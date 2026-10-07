import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { nextTurnDelivery, type NextTurnInstruction } from "#execution/session/next-input.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionExecution } from "#execution/session/turn.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelWorkingTasks, sessionTaskTable } from "#execution/tasks/session.js";
import { workingTasks } from "#execution/tasks/table.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/session/turn-step-types.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { finalizeSession, type SessionTerminalOutcome } from "#execution/session/finalization.js";
import { type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import {
  type CompactionHandoff,
  SessionHandoff,
  sessionAnchorToken,
} from "#execution/session/handoff.js";
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

/** What an owner does before it first waits on its inbox. */
export type SessionStart =
  /** Runs a turn first; `input` is absent for a session started without a message. */
  | { readonly kind: "turn"; readonly input: DeliverHookPayload | undefined }
  /** A prewarmed session parks on the inbox before any session-scoped lifecycle work. */
  | { readonly kind: "first-message" }
  /** A successor that received a settled session waits for its next input. */
  | { readonly kind: "parked" };

export interface SessionBoot {
  readonly anchor: SessionAnchor;
  readonly caller: TurnCaller | undefined;
  readonly capabilities?: SessionCapabilities;
  readonly deploymentId: string;
  readonly history: HarnessModelMessage[];
  readonly initialTurnControl?: TurnControl;
  readonly start: SessionStart;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutControl?: SessionTimeoutControl;
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
    history: boot.history,
    inbox,
    sessionWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
  });
  const progress: SessionProgress = { caller: boot.caller, terminalEmitted: false };
  const handoff = new SessionHandoff({
    checkpoint: {
      capabilities: boot.capabilities,
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
      sessionWritable: boot.sessionWritable,
    });
    progress.terminalEmitted = true;
    return result;
  } catch (error) {
    if (!progress.terminalEmitted) {
      await finalizeSession(
        { error, kind: "failed", turnId: progress.turnId },
        { caller: progress.caller, cursor, sessionWritable: boot.sessionWritable },
      );
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
      sessionWritable: input.sessionWritable,
    },
  );
  throw createSafeOuterWorkflowError();
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
  const queue = new SessionInputQueue();
  const execution = new SessionExecution({
    capabilities: boot.capabilities,
    cursor,
    inbox,
    queue,
    sessionId: boot.sessionId,
  });
  const sessionTimeout = boot.sessionTimeoutControl;

  const nextParkedActivity = async (): Promise<
    Exclude<NextTurnInstruction, { kind: "workflow" | "cancel-working-tasks" }>
  > => {
    while (true) {
      const next = await nextTurnDelivery({
        cursor,
        hasWorkingTasks: () => workingTasks(sessionTaskTable(cursor)).length > 0,
        inbox,
        queue,
      });
      if (next.kind === "workflow") {
        await execution.handleWorkflowMessage(next.message);
        continue;
      }
      if (next.kind === "cancel-working-tasks") {
        await cancelWorkingTasks(cursor, "turn_cancelled");
        continue;
      }
      return next;
    }
  };

  let turnControl =
    boot.initialTurnControl ?? (boot.anchor.kind === "self" ? createTurnControl() : undefined);
  let turnIndex = 0;
  // Set when a turn compacts and kept until the session moves to a fresh run,
  // so this run's event log does not keep growing.
  let compactionHandoffDue = false;
  const runTurn = async (payload: TurnStepPayload | undefined): Promise<TurnOutcome> => {
    const caller = progress.caller;
    const control = turnControl;
    turnControl = undefined;
    progress.turnId = `turn_${String(turnIndex++)}`;
    const outcome = await execution.runTurn(payload, { caller, control });
    if (outcome.caller !== undefined) progress.caller = outcome.caller;
    if (outcome.compacted === true) compactionHandoffDue = true;
    return outcome;
  };
  const transferState = () => ({
    history: cursor.history,
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
  });
  const dueCompactionHandoff = (): CompactionHandoff | undefined =>
    compactionHandoffDue &&
    progress.caller === undefined &&
    workingTasks(sessionTaskTable(cursor)).length === 0
      ? { sessionTimeoutDeadline: boot.sessionTimeoutDeadline }
      : undefined;
  /**
   * Hands a session that compacted to a fresh run on this deployment while
   * nothing is waiting. When input arrives first, the next lone delivery
   * carries the handoff instead; see `runDeliveredTurn`.
   */
  const tryCompactionHandoff = async (): Promise<SessionLoopOutcome | undefined> => {
    const compaction = dueCompactionHandoff();
    if (compaction === undefined || queue.pendingCount > 0 || inbox.hasPending()) return undefined;
    const transfer = await handoff.tryCompactionTransfer(transferState(), compaction);
    return transfer.kind === "transferred" ? transfer : undefined;
  };
  const runDeliveredTurn = async (
    next: Extract<NextTurnInstruction, { kind: "turn" }>,
  ): Promise<SessionActionResult> => {
    const transfer = await handoff.tryTransfer(next, transferState(), {
      compaction: dueCompactionHandoff(),
    });
    if (transfer.kind === "transferred") return transfer;
    if (next.delivery.caller !== undefined) progress.caller = next.delivery.caller;
    return { action: await runTurn({ delivery: next.delivery }), kind: "action" };
  };
  const settleCancelledTurn = async (reportUsage: boolean) => {
    const settled = await cursor.advanceWithHistory((state) =>
      settleCancelledTurnStep({ ...state, reportUsage }),
    );
    progress.caller = undefined;
    return settled;
  };
  const awaitPrewarmedAction = async (): Promise<SessionActionResult> => {
    while (true) {
      const next = await nextParkedActivity();
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
          continue;
      }
    }
  };
  const runInitialAction = async (): Promise<SessionActionResult> => {
    switch (boot.start.kind) {
      case "first-message":
        return await awaitPrewarmedAction();
      case "parked":
        return { action: { kind: "park" }, kind: "action" };
      case "turn": {
        const { input } = boot.start;
        const action = await runTurn(input === undefined ? undefined : { delivery: input });
        return { action, kind: "action" };
      }
    }
  };

  try {
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
        const { caller } = progress;
        const settled = await settleCancelledTurn(caller !== undefined);
        if (caller !== undefined) {
          const notification = { caller, sessionId: boot.sessionId };
          await notifyCancelledTaskCallerStep(
            settled.usage === undefined ? notification : { ...notification, usage: settled.usage },
          );
        }
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

      const transferred = await tryCompactionHandoff();
      if (transferred !== undefined) return transferred;

      const next = await nextParkedActivity();

      switch (next.kind) {
        case "expired":
        case "reset":
        case "closed":
          return { kind: "terminal", outcome: { kind: "expired" } };
        case "clear":
        case "compact":
          action = await runTurn({ control: next.kind });
          continue;
        case "cancel-turn":
          await execution.cancelTurnWork();
          await settleCancelledTurn(false);
          // Cancellation consumes any outstanding caller; do not report the prior turn.
          action = { ...action, settled: undefined };
          continue;
        case "turn": {
          const result = await runDeliveredTurn(next);
          if (result.kind !== "action") return result;
          action = result.action;
          continue;
        }
      }
    }
  } finally {
    turnControl?.dispose();
    await sessionTimeout?.dispose();
  }
}
