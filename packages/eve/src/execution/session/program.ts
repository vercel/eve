import { settleControlDeliveryStep } from "#execution/session/settle-control-delivery-step.js";
import type { ControlSettlement } from "#harness/facts.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import type { ControlDelivery } from "#harness/types.js";
import { STUB_CONTEXT_KEY, type StubScope } from "#tool-stubs/types.js";
import { runServingToolStubs, type ToolStubHost } from "#execution/tool-stub-host.js";
import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { turnCoordinates } from "#protocol/session-projection.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { nextTurnDelivery, type NextTurnInstruction } from "#execution/session/next-input.js";
import { SessionInputQueue, type ControlOrigin } from "#execution/session/input-queue.js";
import { SessionExecution, type SessionTurnHost } from "#execution/session/turn.js";
import { openedBy, type OpenTurn } from "#execution/session/open-turn.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelWorkingTasks, sessionTaskTable } from "#execution/tasks/session.js";
import { workingTasks } from "#execution/tasks/table.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/session/turn-step-types.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { finalizeSession, type SessionTerminalOutcome } from "#execution/session/finalization.js";
import { type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import type { SessionHandoff } from "#execution/session/handoff.js";
import type { SessionTransferState } from "#execution/session/checkpoint.js";
import { prewarmSessionStep } from "#execution/session/prewarm-step.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";

/** The run's own failure never carries internals; the terminal event already logged them. */
function createSafeOuterWorkflowError(): Error {
  const error = new Error("Agent workflow failed. Inspect the private session trace for details.");
  error.name = "EveWorkflowFailure";
  return error;
}

/**
 * Who to tell when this owner exits. The original run anchors the public
 * stream itself; a successor signals the original run through `notify`. A `self` anchor may
 * also name a `notify` step that runs with the final result, which lets an
 * importer settle whatever predecessor still holds the stream open.
 */
export type SessionAnchor =
  | {
      readonly kind: "self";
      readonly notify?: (result: WorkflowEntryResult) => Promise<void>;
    }
  | {
      readonly kind: "successor";
      readonly notify: (result: WorkflowEntryResult) => Promise<void>;
    };

/** What an owner does before it first waits on its inbox. */
export type SessionStart =
  /** Runs a turn first; `input` is absent for a session started without a message. */
  | { readonly kind: "turn"; readonly input: DeliverHookPayload | undefined }
  /**
   * A prewarmed session parks on the inbox before any turn, session event, or
   * session hook, while its session prewarmers run beside the wait.
   */
  | { readonly kind: "first-message" }
  /** A successor that received a settled session waits for its next input. */
  | { readonly kind: "parked" }
  /** Continues a turn that a host saved open, from where its last adopted step left it. */
  | { readonly kind: "resume"; readonly from: OpenTurn };

export interface SessionBoot {
  readonly admittedDeliveryKeys: readonly string[];
  readonly anchor: SessionAnchor;
  readonly caller: TurnCaller | undefined;
  readonly capabilities?: SessionCapabilities;
  /** Compacts the history before the first action, for a session an earlier build recorded. */
  readonly compactFirst?: boolean;
  readonly deploymentId: string;
  readonly history: HarnessModelMessage[];
  readonly initialTurnControl?: TurnControl;
  readonly start: SessionStart;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutControl?: SessionTimeoutControl;
  readonly sessionTimeoutMs: number | false;
  readonly sessionWritable: WritableStream<Uint8Array>;
  /**
   * The stream holds lines past the checkpoint, which a process that stopped inside a step wrote:
   * the session's first step runs again and folds them. Only a host that restores sessions
   * itself sets it; Workflow retries the step.
   */
  readonly rerunFirst?: boolean;
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
  /** The turn a running turn step runs; a crash outside one is attributed to the latest turn. */
  turnId?: string;
}

/**
 * How a session moves between owners: to a successor deployment, to a fresh run after a
 * compaction or prewarm, and back from one that took it over. Workflow moves sessions between
 * runs (`SessionHandoff`); a host that keeps a session in one place retains it every time.
 */
export type SessionMoves = Pick<
  SessionHandoff,
  | "adoptTakeover"
  | "awaitAnchoredResult"
  | "disposeAnchor"
  | "tryCompactionTransfer"
  | "tryPrewarmTransfer"
  | "tryTransfer"
>;

/** What runs a session besides its boot and inbox: its turn steps, its clock, and its moves. */
export interface SessionHost extends SessionTurnHost {
  readonly moves: SessionMoves;
  /** Serves a stubbed eval's tool stubs while its root session runs; see {@link ToolStubHost}. */
  readonly toolStubs?: ToolStubHost;
  /** A host that keeps the session's record itself; Workflow's event log is its own. */
  readonly recorder?: SessionRecorder;
}

/**
 * How a host that keeps sessions follows one. The loop records the session after each step it
 * adopts, and before a step a restore must run again; it goes on once the record resolves.
 */
export interface SessionRecorder {
  adopted(record: SessionRecord): Promise<void>;
  /**
   * Whether the host suspended the session: it stopped keeping it, to continue it later from
   * the record it kept, as after a crash. A suspended session's loop stops without ending the
   * session, so nothing it holds (its sandbox, its children) is torn down.
   */
  suspended(): boolean;
}

/**
 * The session as a successor would continue it, where its open turn goes on, and the run
 * messages it read since the record before.
 */
export interface SessionRecord {
  readonly transfer: SessionTransferState;
  readonly open: OpenTurn | undefined;
  readonly consumed: readonly WorkflowToolRunMessage[];
}

/** A session loop started by {@link startPreparedSession}. */
export interface StartedSession {
  /** The loop's result, once the session ends or moves. */
  readonly finished: Promise<WorkflowEntryResult>;
  /** Resolves once no step of the session is running and the last one is recorded. */
  settledStep(): Promise<void>;
}

/** Runs an already prepared owner against its session's existing stream. */
export async function runPreparedSession(
  boot: SessionBoot,
  inbox: SessionInboxHandle,
  host: SessionHost,
): Promise<WorkflowEntryResult> {
  return await startPreparedSession(boot, inbox, host).finished;
}

/** {@link runPreparedSession}, with a handle on the loop while it runs. */
export function startPreparedSession(
  boot: SessionBoot,
  inbox: SessionInboxHandle,
  host: SessionHost,
): StartedSession {
  const scope = boot.serializedContext[STUB_CONTEXT_KEY] as StubScope | undefined;
  if (scope !== undefined && scope.rootSessionId === undefined) {
    boot.serializedContext[STUB_CONTEXT_KEY] = { ...scope, rootSessionId: boot.sessionId };
  }
  const { recorder } = host;
  const queue = new SessionInputQueue(boot.admittedDeliveryKeys);
  const cursor: SessionStateCursor = new SessionStateCursor({
    history: boot.history,
    inbox,
    open: openTurnOf(boot.start),
    sessionWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
    ...(recorder !== undefined && {
      record: async (change) =>
        await recorder.adopted({ ...change, transfer: transferStateOf(cursor, queue) }),
    }),
    ...(boot.rerunFirst === true && { rerunFirst: true }),
  });
  return {
    finished: runSession(boot, { cursor, host, inbox, queue, scope }),
    settledStep: () => cursor.settledStep(),
  };
}

/** The record of a session as it boots, before its loop records it. */
export function recordOf(boot: SessionBoot): SessionRecord {
  const { admittedDeliveryKeys, history, serializedContext, sessionState } = boot;
  return {
    consumed: [],
    open: openTurnOf(boot.start),
    transfer: { admittedDeliveryKeys, history, serializedContext, sessionState },
  };
}

/** Where the open turn goes on as a session starts: the one it resumes, or its first message's. */
function openTurnOf(start: SessionStart): OpenTurn | undefined {
  switch (start.kind) {
    case "resume":
      return start.from;
    case "turn":
      return openedBy(start.input);
    default:
      return undefined;
  }
}

/** What a successor would continue the session from, as of the last step it adopted. */
function transferStateOf(
  cursor: SessionStateCursor,
  queue: SessionInputQueue,
): SessionTransferState {
  return {
    admittedDeliveryKeys: queue.admittedDeliveryKeys,
    history: cursor.history,
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
  };
}

/** What a suspended session's loop returns: it didn't end, so it has no result. */
const SUSPENDED_RESULT: WorkflowEntryResult = { output: "" };

async function runSession(
  boot: SessionBoot,
  deps: {
    readonly cursor: SessionStateCursor;
    readonly host: SessionHost;
    readonly inbox: SessionInboxHandle;
    readonly queue: SessionInputQueue;
    readonly scope: StubScope | undefined;
  },
): Promise<WorkflowEntryResult> {
  const { cursor, host, inbox, queue, scope } = deps;
  const progress: SessionProgress = { caller: boot.caller };
  const handoff = host.moves;
  let result: WorkflowEntryResult = { output: "", isError: true };
  let loop: SessionLoopOutcome | undefined;
  let finalizing = false;
  // Once its host suspended it, whatever the loop decides (its inbox closed, a turn that lost its
  // inbox failing) is the host going away, not the session ending.
  const suspended = (): boolean => host.recorder?.suspended() === true;
  try {
    result = await runServingToolStubs(host.toolStubs, scope, boot.sessionId, async () => {
      try {
        loop = await runSessionLoop(boot, { cursor, host, inbox, progress, queue });
      } finally {
        await inbox.dispose();
      }
      if (loop.kind === "transferred") {
        if (boot.anchor.kind !== "self") return { output: "" };
        result = await handoff.awaitAnchoredResult();
        return result;
      }
      if (suspended()) return SUSPENDED_RESULT;
      finalizing = true;
      result = await finalizeSession(loop.outcome, {
        caller: progress.caller,
        cursor,
        sessionWritable: boot.sessionWritable,
      });
      return result;
    });
    return result;
  } catch (error) {
    if (!finalizing && suspended()) return SUSPENDED_RESULT;
    // Once finalization of the decided outcome starts, failing it must not report a different
    // outcome. The channel may already have handled the decided terminal event.
    if (!finalizing) {
      await finalizeSession(
        { error, kind: "failed", turnId: progress.turnId },
        { caller: progress.caller, cursor, sessionWritable: boot.sessionWritable },
      );
    }
    throw createSafeOuterWorkflowError();
  } finally {
    // Also dispose if playback setup fails before the session loop starts. Disposal is idempotent.
    await inbox.dispose();
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
  handoff: SessionMoves,
  loop: SessionLoopOutcome | undefined,
): Promise<void> {
  switch (boot.anchor.kind) {
    case "self":
      await handoff.disposeAnchor();
      await boot.anchor.notify?.(result);
      return;
    case "successor":
      if (loop?.kind === "transferred") return;
      await boot.anchor.notify(result);
      return;
  }
}

async function runSessionLoop(
  boot: SessionBoot,
  deps: {
    readonly cursor: SessionStateCursor;
    readonly host: SessionHost;
    readonly inbox: SessionInboxHandle;
    readonly progress: SessionProgress;
    readonly queue: SessionInputQueue;
  },
): Promise<SessionLoopOutcome> {
  const { cursor, host, inbox, progress, queue } = deps;
  const handoff = host.moves;
  const execution = new SessionExecution({
    capabilities: boot.capabilities,
    cursor,
    host,
    inbox,
    queue,
    sessionId: boot.sessionId,
  });
  const sessionTimeout = boot.sessionTimeoutControl;
  // A prewarmed session's prewarm step, which runs beside the session's own steps.
  let prewarming: Promise<void> = Promise.resolve();
  let prewarmSettled = true;
  // What it prepared is kept only while the owner still waits for its first input.
  let awaitingFirstInput = false;
  // Controls to a prewarmed session change nothing, and settle once it has started: nothing
  // precedes `session.started`.
  const unstarted: ControlSettlement[] = [];
  const started = () =>
    storedProjection(cursor.sessionState.snapshot.session.state).view.session.status !== "new";
  const ignore = async (settlement: ControlSettlement): Promise<void> => {
    if (!started()) {
      unstarted.push(settlement);
      return;
    }
    await cursor.advance((state) => settleControlDeliveryStep({ ...state, settlement }));
  };
  const settleUnstarted = async (): Promise<void> => {
    if (!started()) return;
    for (const settlement of unstarted.splice(0))
      await cursor.advance((state) => settleControlDeliveryStep({ ...state, settlement }));
  };
  // A session that ends before it started settles them in its end's commit.
  const expired = (control?: ControlDelivery): SessionTerminalOutcome => ({
    kind: "expired",
    ...(control && { control }),
    ...(unstarted.length > 0 && { settles: unstarted.splice(0) }),
  });

  const nextParkedActivity = async (): Promise<
    | Exclude<NextTurnInstruction, { kind: "workflow" | "cancel-working-tasks" | "prewarm" }>
    | { readonly kind: "transferred" }
  > => {
    while (true) {
      const next = await nextTurnDelivery({
        cursor,
        hasWorkingTasks: () => workingTasks(sessionTaskTable(cursor)).length > 0,
        ignore,
        inbox,
        queue,
      });
      if (next.kind === "prewarm") {
        // A prewarm step still starting a sandbox keeps the session here: a
        // successor could end the session and clean up before that start lands.
        if (
          prewarmSettled &&
          progress.caller === undefined &&
          workingTasks(sessionTaskTable(cursor)).length === 0 &&
          queue.pendingCount === 0 &&
          !inbox.hasPending()
        ) {
          const deadline = sessionTimeout?.getDeadline();
          const result = await handoff.tryPrewarmTransfer(
            transferState(),
            next.targetDeploymentId,
            deadline,
          );
          if (result.kind === "transferred") return result;
        }
        continue;
      }
      if (next.kind === "workflow") {
        await execution.handleWorkflowMessage(next.message);
        continue;
      }
      if (next.kind === "cancel-working-tasks") {
        await cancelWorkingTasks(cursor, "turn-cancelled");
        if (next.origin !== undefined) {
          const control = controlDeliveryOf(next.origin);
          await cursor.advance((state) =>
            settleControlDeliveryStep({
              ...state,
              settlement: { control, outcome: "applied", source: "cancel" },
            }),
          );
        }
        continue;
      }
      if (next.kind === "expired" && sessionTimeout !== undefined) {
        // Input accepted behind the timer's signal would be lost if the session ended now.
        if (queue.pendingCount > 0 || inbox.hasPending()) sessionTimeout.recordActivity();
        if ((await sessionTimeout.handleTimerElapsed()) === "extended") continue;
      }
      return next;
    }
  };

  let turnControl =
    boot.initialTurnControl ?? (boot.anchor.kind === "self" ? createTurnControl() : undefined);
  // Set when a turn compacts and kept until the session moves to a fresh run,
  // so this run's event log does not keep growing.
  let compactionHandoffDue = false;
  const runTurn = async (
    payload: TurnStepPayload | undefined,
    pause?: TurnPause,
  ): Promise<TurnOutcome> => {
    const caller = progress.caller;
    const control = turnControl;
    turnControl = undefined;
    // A step that fails can leave the turn it opened out of the cursor, so the turn is read
    // before the step runs. Controls run between turns.
    progress.turnId =
      payload?.control === undefined
        ? turnCoordinates(storedProjection(cursor.sessionState.snapshot.session.state)).turnId
        : undefined;
    const outcome = await execution.runTurn(payload, {
      caller,
      control,
      ...(pause !== undefined && { pause }),
    });
    progress.turnId = undefined;
    sessionTimeout?.recordActivity();
    if (outcome.caller !== undefined) progress.caller = outcome.caller;
    if (outcome.compacted === true) compactionHandoffDue = true;
    return outcome;
  };
  const transferState = (): SessionTransferState => transferStateOf(cursor, queue);
  const compactionHandoffReady = (): boolean =>
    compactionHandoffDue &&
    progress.caller === undefined &&
    workingTasks(sessionTaskTable(cursor)).length === 0;
  /**
   * Hands a session that compacted to a fresh run on this deployment while
   * nothing is waiting. Input that is already waiting runs here first, and
   * the session moves at the next quiet boundary; input that arrives once the
   * move has started runs on the successor.
   */
  const tryCompactionHandoff = async (): Promise<SessionLoopOutcome | undefined> => {
    if (!compactionHandoffReady() || queue.pendingCount > 0 || inbox.hasPending()) return undefined;
    const transfer = await handoff.tryCompactionTransfer(transferState());
    return transfer.kind === "transferred" ? transfer : undefined;
  };
  const runDeliveredTurn = async (
    next: Extract<NextTurnInstruction, { kind: "turn" }>,
  ): Promise<SessionActionResult> => {
    const transfer = await handoff.tryTransfer(next, transferState());
    if (transfer.kind === "transferred") return transfer;
    if (next.delivery.caller !== undefined) progress.caller = next.delivery.caller;
    return { action: await runTurn({ delivery: next.delivery }), kind: "action" };
  };
  /**
   * Settles the turn a cancel stopped. With `report`, its delegated caller hears it, with the
   * turn's usage. A host that keeps sessions records it first, so a restore settles it again.
   */
  const settleCancelledTurn = async (report: boolean, control?: ControlDelivery) => {
    const { caller } = progress;
    const settled = await cursor.advanceWithHistory(
      (state) => settleCancelledTurnStep({ ...state, control, reportUsage: report }),
      { after: () => undefined, before: { at: "cancel", report, ...(control && { control }) } },
    );
    progress.caller = undefined;
    if (report && caller !== undefined) {
      const notification = { caller, sessionId: boot.sessionId };
      await notifyCancelledTaskCallerStep(
        settled.usage === undefined ? notification : { ...notification, usage: settled.usage },
      );
    }
  };
  const awaitPrewarmedAction = async (): Promise<SessionActionResult> => {
    while (true) {
      const next = await nextParkedActivity();
      // A transfer or turn may start next, and neither must see the session change under it.
      awaitingFirstInput = false;
      switch (next.kind) {
        case "reset":
          return {
            kind: "terminal",
            outcome: expired(next.origin && controlDeliveryOf(next.origin)),
          };
        case "closed":
          // Taken over outside an attempt: the new owner now writes the stream.
          if (inbox.takenOver) return await handoff.adoptTakeover();
          return { kind: "terminal", outcome: expired() };
        case "transferred":
          return next;
        case "expired":
          return { kind: "terminal", outcome: expired() };
        case "clear":
        case "compact":
          if (next.origin !== undefined)
            await ignore({
              control: controlDeliveryOf(next.origin),
              outcome: "ignored",
              source: next.kind,
            });
          continue;
        case "turn":
          return await runDeliveredTurn(next);
        case "cancel-turn":
          continue;
      }
    }
  };
  const runInitialAction = async (): Promise<SessionActionResult> => {
    if (boot.compactFirst === true) {
      // A failed compaction keeps the history; the session continues either way. This run already
      // starts fresh, so the compaction moves it nowhere.
      await runTurn({ control: "compact" });
      compactionHandoffDue = false;
    }
    switch (boot.start.kind) {
      case "first-message":
        // Beside the wait, so a first message starts its turn without waiting
        // for it. Provider `start()` upserts by session id, so a turn that
        // opens the sandbox meanwhile reaches the one being prewarmed.
        awaitingFirstInput = true;
        prewarmSettled = false;
        prewarming = cursor
          .advanceBeside(
            ({ serializedContext, sessionState }) =>
              prewarmSessionStep({ serializedContext, sessionState }),
            () => awaitingFirstInput,
          )
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            prewarmSettled = true;
          });
        return await awaitPrewarmedAction();
      case "parked":
        return { action: { kind: "park" }, kind: "action" };
      case "turn": {
        const { input } = boot.start;
        const action = await runTurn(input === undefined ? undefined : { delivery: input });
        return { action, kind: "action" };
      }
      case "resume": {
        const { from } = boot.start;
        // The turn answers the caller of the input it goes on with, or else the one its first
        // step bound into the context, as a failed boot does: one only the loop held is gone.
        progress.caller ??=
          (from.at === "step" ? from.input?.delivery?.caller : undefined) ??
          (await resolveInitialTurnCallerStep({ serializedContext: cursor.serializedContext }));
        if (from.at === "cancel") {
          await settleCancelledTurn(from.report, from.control);
          return { action: { kind: "park" }, kind: "action" };
        }
        const action =
          from.at === "step" ? await runTurn(from.input) : await runTurn(undefined, from.pause);
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
      // A first turn that ended the session left no commit after its start for them.
      if (action.kind === "done") {
        return { kind: "terminal", outcome: { action, kind: "done" } };
      }
      await settleUnstarted();

      if (action.cancelled === true) {
        await settleCancelledTurn(progress.caller !== undefined, action.cancelledBy);
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

      // Registered while parked, so the next turn's first step is not held
      // behind its abort hooks.
      turnControl ??= createTurnControl();
      const next = await nextParkedActivity();

      switch (next.kind) {
        case "reset":
          return { kind: "terminal", outcome: resetOutcome(next.origin) };
        case "closed":
          // Taken over outside an attempt: the new owner now writes the stream.
          if (inbox.takenOver) return await handoff.adoptTakeover();
          return { kind: "terminal", outcome: { kind: "expired" } };
        case "transferred":
          return next;
        case "expired":
          return { kind: "terminal", outcome: { kind: "expired" } };
        case "clear":
        case "compact":
          // A clear that waited behind a compaction found no turn to cancel; its tasks stop here.
          if (next.kind === "clear")
            await cancelWorkingTasks(cursor, "turn-cancelled", { turnCalls: true });
          action = await runTurn(
            next.origin === undefined
              ? { control: next.kind }
              : { control: next.kind, controlDelivery: controlDeliveryOf(next.origin) },
          );
          continue;
        case "cancel-turn":
          await execution.cancelTurnWork();
          await settleCancelledTurn(
            false,
            next.origin === undefined ? undefined : controlDeliveryOf(next.origin),
          );
          sessionTimeout?.recordActivity();
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
    awaitingFirstInput = false;
    // Session end must not clean up before a sandbox the prewarm step is still starting.
    await prewarming;
    await sessionTimeout?.dispose();
  }
}

/** A reset ends the session; the delivery it arrived as is the end's cause. */
function resetOutcome(origin: ControlOrigin | undefined): SessionTerminalOutcome {
  return origin === undefined
    ? { kind: "expired" }
    : { control: controlDeliveryOf(origin), kind: "expired" };
}
