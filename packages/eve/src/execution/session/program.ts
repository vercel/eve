import { pendingSessionEnd } from "#definitions/continuation.js";
import { settleControlDeliveryStep } from "#execution/session/settle-control-delivery-step.js";
import type { ControlSettlement } from "#harness/facts.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import type { ControlDelivery } from "#harness/types.js";
import { STUB_CONTEXT_KEY, type StubScope } from "#tool-stubs/types.js";
import { runServingToolStubs, type ToolStubHost } from "#execution/tool-stub-host.js";
import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import { SESSION_CALLBACK_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { resolveLocalInitialTurnCaller } from "#subagents/initial-caller.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#subagents/parent-notification.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { sessionUsage } from "#harness/session-usage.js";
import { isBetweenTurns, storedProjection } from "#harness/session-machine/view.js";
import { turnCoordinates } from "#protocol/session-projection.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { nextTurnDelivery, type NextTurnInstruction } from "#execution/session/next-input.js";
import { SessionInputQueue, type ControlOrigin } from "#execution/session/input-queue.js";
import { SessionExecution, type SessionTurnHost } from "#execution/session/turn.js";
import {
  createTurnControl,
  nextTurnControl,
  type TurnControl,
} from "#execution/session/turn-control.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelWorkingTasks, sessionTaskTable } from "#execution/tasks/session.js";
import { workingTasks } from "#execution/tasks/table.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/session/turn-step-types.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { finalizeSession, type SessionTerminalOutcome } from "#execution/session/finalization.js";
import { type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import type { SessionHandoff } from "#execution/session/handoff.js";
import { prewarmSessionStep } from "#execution/session/prewarm-step.js";
import { stopIdleSessionSandboxStep } from "#execution/session/idle-sandbox-step.js";
import type { SandboxRunning } from "#sandbox/state.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";

function createSafeOuterWorkflowError(): Error {
  const error = new Error("Agent workflow failed. Inspect the private session trace for details.");
  error.name = "EveWorkflowFailure";
  return error;
}

export type SessionAnchor =
  | {
      readonly kind: "self";
      readonly notify?: (result: WorkflowEntryResult) => Promise<void>;
    }
  | {
      readonly kind: "successor";
      readonly notify: (result: WorkflowEntryResult) => Promise<void>;
    };

export type SessionStart =
  | { readonly kind: "turn"; readonly input: DeliverHookPayload | undefined }
  | { readonly kind: "first-message" }
  | { readonly kind: "parked" };

export interface SessionBoot {
  readonly admittedDeliveryKeys: readonly string[];
  readonly anchor: SessionAnchor;
  readonly caller: TurnCaller | undefined;
  readonly capabilities?: SessionCapabilities;
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
}

type SessionLoopOutcome =
  | { readonly kind: "terminal"; readonly outcome: SessionTerminalOutcome }
  | { readonly kind: "transferred" };

type SessionActionResult =
  | { readonly action: TurnOutcome; readonly kind: "action" }
  | SessionLoopOutcome;

interface SessionProgress {
  caller: TurnCaller | undefined;
  turnId?: string;
}

export type SessionMoves = Pick<
  SessionHandoff,
  | "adoptTakeover"
  | "awaitAnchoredResult"
  | "disposeAnchor"
  | "tryCompactionTransfer"
  | "tryPrewarmTransfer"
  | "tryTransfer"
>;

const RETAINED: SessionMoves = {
  adoptTakeover: async () => {
    throw new Error("A session its host keeps in one place can't be taken over.");
  },
  awaitAnchoredResult: async () => {
    throw new Error("A session its host keeps in one place never moves, so nothing anchors it.");
  },
  disposeAnchor: async () => {},
  tryCompactionTransfer: async () => ({ kind: "retained", reason: "same-deployment" }),
  tryPrewarmTransfer: async () => ({ kind: "retained", reason: "same-deployment" }),
  tryTransfer: async () => ({ kind: "retained", reason: "same-deployment" }),
};

export interface SessionHost extends SessionTurnHost {
  readonly moves?: SessionMoves;
  readonly toolStubs?: ToolStubHost;
}

export async function runPreparedSession(
  boot: SessionBoot,
  inbox: SessionInboxHandle,
  host: SessionHost,
): Promise<WorkflowEntryResult> {
  const scope = boot.serializedContext[STUB_CONTEXT_KEY] as StubScope | undefined;
  if (scope !== undefined && scope.rootSessionId === undefined) {
    boot.serializedContext[STUB_CONTEXT_KEY] = { ...scope, rootSessionId: boot.sessionId };
  }
  const cursor = new SessionStateCursor({
    history: boot.history,
    inbox,
    sessionWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
  });
  const progress: SessionProgress = { caller: boot.caller };
  const handoff = host.moves ?? RETAINED;
  let result: WorkflowEntryResult = { output: "", isError: true };
  let loop: SessionLoopOutcome | undefined;
  let finalizing = false;
  try {
    result = await runServingToolStubs(host.toolStubs, scope, boot.sessionId, async () => {
      try {
        loop = await runSessionLoop(boot, { cursor, host, inbox, progress });
      } finally {
        await inbox.dispose();
      }
      if (loop.kind === "transferred") {
        if (boot.anchor.kind !== "self") return { output: "" };
        result = await handoff.awaitAnchoredResult();
        return result;
      }
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
    if (!finalizing) {
      await finalizeSession(
        { error, kind: "failed", turnId: progress.turnId },
        { caller: progress.caller, cursor, sessionWritable: boot.sessionWritable },
      );
    }
    throw createSafeOuterWorkflowError();
  } finally {
    await inbox.dispose();
    await reportResultToAnchor(boot, result, handoff, loop);
  }
}

export async function failSession(input: {
  readonly error: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<never> {
  let caller: TurnCaller | undefined;
  try {
    caller =
      input.serializedContext[SESSION_CALLBACK_CONTEXT_KEY_NAME] !== undefined
        ? await resolveInitialTurnCallerStep({ serializedContext: input.serializedContext })
        : resolveLocalInitialTurnCaller(input.serializedContext);
  } catch {}
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
  },
): Promise<SessionLoopOutcome> {
  const { cursor, host, inbox, progress } = deps;
  const handoff = host.moves ?? RETAINED;
  const queue = new SessionInputQueue(boot.admittedDeliveryKeys);
  const execution = new SessionExecution({
    capabilities: boot.capabilities,
    cursor,
    host,
    inbox,
    queue,
    sessionId: boot.sessionId,
  });
  const sessionTimeout = boot.sessionTimeoutControl;
  let prewarming: Promise<void> = Promise.resolve();
  let prewarmSettled = true;
  let awaitingFirstInput = false;
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
  const expired = (control?: ControlDelivery): SessionTerminalOutcome => ({
    kind: "expired",
    ...(control && { control }),
    ...(unstarted.length > 0 && { settles: unstarted.splice(0) }),
  });
  const hookEnded = (
    hook: string,
    turn?: Pick<
      Extract<SessionTerminalOutcome, { readonly kind: "ended" }>,
      "cancelled" | "settled"
    >,
  ): SessionTerminalOutcome => ({
    cause: { hook },
    kind: "ended",
    ...(turn?.cancelled !== undefined && { cancelled: turn.cancelled }),
    ...(turn?.settled !== undefined && { settled: turn.settled }),
    ...(unstarted.length > 0 && { settles: unstarted.splice(0) }),
  });

  let prewarmedSandbox: SandboxRunning | undefined;
  let idleWindow: Promise<void> | "attempted" | undefined;
  const sandboxMayBeRunning = (): SandboxRunning | undefined =>
    readDurableSession(cursor.sessionState).sandboxState?.running ?? prewarmedSandbox;
  const sessionBusy = (): boolean =>
    queue.pendingCount > 0 ||
    workingTasks(sessionTaskTable(cursor)).length > 0 ||
    !isBetweenTurns(storedProjection(cursor.sessionState.snapshot.session.state));
  const beforeInbox = async (other: Promise<unknown>): Promise<boolean> =>
    await Promise.race([inbox.whenPending().then(() => false), other.then(() => true)]);
  const stopSandboxOnceIdle = async (): Promise<void> => {
    while (!inbox.hasPending()) {
      if (!prewarmSettled) {
        if (!(await beforeInbox(prewarming))) return;
        continue;
      }
      const running = sandboxMayBeRunning();
      if (running === undefined) idleWindow = undefined;
      if (running === undefined || idleWindow === "attempted" || sessionBusy()) return;
      if (inbox.awaitingHandover) {
        if (!(await beforeInbox(inbox.whenHandoverSettled()))) return;
        continue;
      }
      if (running.idleTimeoutMs > 0) {
        idleWindow ??= host.until(Date.now() + running.idleTimeoutMs);
        if (!(await beforeInbox(idleWindow)) || inbox.hasPending()) return;
      }
      idleWindow = "attempted";
      prewarmedSandbox = undefined;
      await cursor
        .advance(({ serializedContext, sessionState }) =>
          stopIdleSessionSandboxStep({ serializedContext, sessionState }),
        )
        .catch(() => undefined);
      return;
    }
  };

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
        whileWaiting: stopSandboxOnceIdle,
      });
      if (next.kind === "prewarm") {
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
        if (queue.pendingCount > 0 || inbox.hasPending()) sessionTimeout.recordActivity();
        if ((await sessionTimeout.handleTimerElapsed()) === "extended") continue;
      }
      return next;
    }
  };

  let turnControl =
    boot.initialTurnControl ?? (boot.anchor.kind === "self" ? createTurnControl() : undefined);
  let compactionHandoffDue = false;
  const runTurn = async (payload: TurnStepPayload | undefined): Promise<TurnOutcome> => {
    const caller = progress.caller;
    const control = turnControl;
    turnControl = undefined;
    idleWindow = undefined;
    progress.turnId =
      payload?.control === undefined
        ? turnCoordinates(storedProjection(cursor.sessionState.snapshot.session.state)).turnId
        : undefined;
    const outcome = await execution.runTurn(payload, { caller, control });
    if (control !== undefined) turnControl ??= nextTurnControl(control);
    progress.turnId = undefined;
    sessionTimeout?.recordActivity();
    if (outcome.caller !== undefined) progress.caller = outcome.caller;
    if (outcome.compacted === true) compactionHandoffDue = true;
    return outcome;
  };
  const transferState = () => ({
    admittedDeliveryKeys: queue.admittedDeliveryKeys,
    history: cursor.history,
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
  });
  const compactionHandoffReady = (): boolean =>
    compactionHandoffDue &&
    progress.caller === undefined &&
    workingTasks(sessionTaskTable(cursor)).length === 0;
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
  const settleCancelledTurn = async (reportUsage: boolean, control?: ControlDelivery) => {
    const settled = await cursor.advanceWithHistory((state) =>
      settleCancelledTurnStep({ ...state, control, reportUsage }),
    );
    progress.caller = undefined;
    return settled;
  };
  const awaitPrewarmedAction = async (): Promise<SessionActionResult> => {
    while (true) {
      const next = await nextParkedActivity();
      awaitingFirstInput = false;
      switch (next.kind) {
        case "reset":
          return {
            kind: "terminal",
            outcome: expired(next.origin && controlDeliveryOf(next.origin)),
          };
        case "end":
          return { kind: "terminal", outcome: hookEnded(next.hook) };
        case "closed":
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
      await runTurn({ control: "compact" });
      compactionHandoffDue = false;
      const end = pendingSessionEnd(cursor.serializedContext);
      if (end !== undefined) return { kind: "terminal", outcome: hookEnded(end.hook) };
    }
    switch (boot.start.kind) {
      case "first-message":
        awaitingFirstInput = true;
        prewarmSettled = false;
        prewarming = cursor
          .advanceBeside(
            async ({ serializedContext, sessionState }) => {
              const prewarmed = await prewarmSessionStep({ serializedContext, sessionState });
              prewarmedSandbox = prewarmed.sandboxRunning;
              return prewarmed;
            },
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
    }
  };

  try {
    const defersTimer = boot.start.kind === "turn";
    const [actionResult, timerResult] = await Promise.allSettled([
      runInitialAction(),
      defersTimer ? Promise.resolve() : sessionTimeout?.start(),
    ]);
    if (timerResult.status === "rejected") throw timerResult.reason;
    if (actionResult.status === "rejected") throw actionResult.reason;
    const initial = actionResult.value;
    if (initial.kind !== "action") return initial;
    let action = initial.action;
    let timerStarted = !defersTimer;
    let timerFailure: Promise<never> | undefined;

    const armTimer = (): void => {
      if (timerStarted || sessionTimeout === undefined) return;
      timerStarted = true;
      const failure = sessionTimeout.start().then(() => {
        if (timerFailure === failure) timerFailure = undefined;
        return new Promise<never>(() => {});
      });
      failure.catch(() => undefined);
      timerFailure = failure;
    };

    while (true) {
      if (action.kind === "done") {
        return { kind: "terminal", outcome: { action, kind: "done" } };
      }
      await settleUnstarted();

      if (action.cancelled === true) {
        const { caller } = progress;
        const settled = await settleCancelledTurn(caller !== undefined, action.cancelledBy);
        const end = pendingSessionEnd(cursor.serializedContext);
        if (end !== undefined) {
          progress.caller = caller;
          return {
            kind: "terminal",
            outcome: hookEnded(end.hook, { cancelled: { usage: settled.usage } }),
          };
        }
        if (caller !== undefined) {
          const notification = { caller, sessionId: boot.sessionId };
          await notifyCancelledTaskCallerStep(
            settled.usage === undefined ? notification : { ...notification, usage: settled.usage },
          );
        }
      } else {
        const end = pendingSessionEnd(cursor.serializedContext);
        if (end !== undefined) {
          return {
            kind: "terminal",
            outcome: hookEnded(end.hook, { settled: action.settled }),
          };
        }
        if (action.settled !== undefined) {
          if (progress.caller !== undefined) {
            const totalUsage =
              progress.caller.directTask !== undefined
                ? sessionUsage(cursor.sessionState.snapshot.session)
                : undefined;
            await notifyTurnCallerStep({
              caller: progress.caller,
              lifecycle: "parked",
              sessionId: boot.sessionId,
              settled: action.settled,
              ...(totalUsage !== undefined && { totalUsage }),
            });
          }
          progress.caller = undefined;
        }
      }

      const transferred = await tryCompactionHandoff();
      if (transferred !== undefined) return transferred;

      armTimer();

      turnControl ??= createTurnControl();
      const next =
        timerFailure === undefined
          ? await nextParkedActivity()
          : await Promise.race([nextParkedActivity(), timerFailure]);

      switch (next.kind) {
        case "reset":
          return { kind: "terminal", outcome: resetOutcome(next.origin) };
        case "end":
          return { kind: "terminal", outcome: hookEnded(next.hook) };
        case "closed":
          if (inbox.takenOver) return await handoff.adoptTakeover();
          return { kind: "terminal", outcome: { kind: "expired" } };
        case "transferred":
          return next;
        case "expired":
          return { kind: "terminal", outcome: { kind: "expired" } };
        case "clear":
        case "compact":
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
    await prewarming;
    await sessionTimeout?.dispose();
  }
}

function resetOutcome(origin: ControlOrigin | undefined): SessionTerminalOutcome {
  return origin === undefined
    ? { kind: "expired" }
    : { control: controlDeliveryOf(origin), kind: "expired" };
}
