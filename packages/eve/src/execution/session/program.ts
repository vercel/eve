import type { ControlSettlement } from "#harness/facts.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import type { ControlDelivery } from "#harness/types.js";
import { STUB_CONTEXT_KEY, type StubScope } from "#tool-stubs/types.js";
import { runServingToolStubs, type ToolStubHost } from "#execution/tool-stub-host.js";
import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
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
import { openedBy, type OpenTurn } from "#execution/session/open-turn.js";
import { sealSessionRecord, type SessionRecord } from "#execution/session/record.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { cancelWorkingTasks, sessionTaskTable } from "#execution/tasks/session.js";
import { workingTasks } from "#execution/tasks/table.js";
import type { TurnOutcome, TurnStepPayload } from "#execution/session/turn-step-types.js";
import { finalizeSession, type SessionTerminalOutcome } from "#execution/session/finalization.js";
import { type SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import type { SessionHandoff } from "#execution/session/handoff.js";
import type { SessionTransferState } from "#execution/session/checkpoint.js";
import {
  sessionStepKeys,
  type SessionStepCall,
  type SessionStepName,
  type SessionStepRunner,
} from "#execution/session/steps.js";
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
  | { readonly kind: "parked" }
  | { readonly kind: "resume"; readonly from: OpenTurn };

export interface SessionBoot {
  readonly admittedDeliveryKeys: readonly string[];
  readonly anchor: SessionAnchor;
  readonly caller: TurnCaller | undefined;
  readonly capabilities?: SessionCapabilities;
  readonly compactFirst?: boolean;
  readonly deploymentId: string;
  readonly generation?: number;
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
  readonly rerunFirst?: boolean;
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
  adopted?(record: SessionRecord, consumed: { readonly throughSeq: number }): Promise<void>;
}

export type SessionRunResult =
  | { readonly kind: "ended"; readonly outcome: "completed" | "failed" | "cancelled" }
  | { readonly kind: "parked"; readonly record: SessionRecord; readonly wakeAt?: number }
  | { readonly kind: "moved" };

export interface StartedSession {
  readonly finished: Promise<WorkflowEntryResult>;
  readonly result: Promise<SessionRunResult>;
  settledStep(): Promise<void>;
}

export async function runPreparedSession(
  boot: SessionBoot,
  inbox: SessionInboxHandle,
  host: SessionHost,
): Promise<WorkflowEntryResult> {
  return await startPreparedSession(boot, inbox, host).finished;
}

export function startPreparedSession(
  boot: SessionBoot,
  inbox: SessionInboxHandle,
  host: SessionHost,
): StartedSession {
  const scope = boot.serializedContext[STUB_CONTEXT_KEY] as StubScope | undefined;
  if (scope !== undefined && scope.rootSessionId === undefined) {
    boot.serializedContext[STUB_CONTEXT_KEY] = { ...scope, rootSessionId: boot.sessionId };
  }
  const queue = new SessionInputQueue(boot.admittedDeliveryKeys);
  const records = recordsOf(boot, host, inbox, queue);
  const cursor: SessionStateCursor = new SessionStateCursor({
    history: boot.history,
    inbox,
    open: openTurnOf(boot.start),
    sessionWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
    ...(records !== undefined && { record: () => records.write(cursor) }),
    ...(boot.rerunFirst === true && { rerunFirst: true }),
  });
  const outcome = Promise.withResolvers<SessionRunResult>();
  const finished = runBootedSession(boot, {
    cursor,
    host,
    inbox,
    queue,
    records,
    scope,
    settle: outcome.resolve,
  });
  return {
    finished,
    result: finished.then(
      async () => await outcome.promise,
      () => ({ kind: "ended", outcome: "failed" }) as const,
    ),
    settledStep: () => cursor.settledStep(),
  };
}

interface SessionRecords {
  quiet(): boolean;
  write(cursor: SessionStateCursor): Promise<void> | undefined;
  keep(cursor: SessionStateCursor): Promise<SessionRecord>;
  watch(execution: SessionExecution): void;
}

function recordsOf(
  boot: SessionBoot,
  host: SessionHost,
  inbox: SessionInboxHandle,
  queue: SessionInputQueue,
): SessionRecords | undefined {
  const { adopted } = host;
  if (adopted === undefined) return undefined;
  let generation = boot.generation ?? 0;
  let execution: SessionExecution | undefined;
  const seal = (cursor: SessionStateCursor): SessionRecord =>
    sealSessionRecord({
      generation: ++generation,
      open: cursor.open,
      transfer: transferStateOf(cursor, queue),
    });
  const records: SessionRecords = {
    quiet: () => queue.pendingCount === 0 && execution?.holdsInput() !== true,
    write(cursor) {
      if (!records.quiet()) return undefined;
      return adopted.call(host, seal(cursor), { throughSeq: inbox.takenThrough });
    },
    async keep(cursor) {
      const record = seal(cursor);
      await adopted.call(host, record, { throughSeq: inbox.takenThrough });
      return record;
    },
    watch(watched) {
      execution = watched;
    },
  };
  return records;
}

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

class SessionParked {
  readonly result: Extract<SessionRunResult, { readonly kind: "parked" }>;

  constructor(result: Extract<SessionRunResult, { readonly kind: "parked" }>) {
    this.result = result;
  }
}

const PARKED_RESULT: WorkflowEntryResult = { output: "" };

async function runBootedSession(
  boot: SessionBoot,
  deps: {
    readonly cursor: SessionStateCursor;
    readonly host: SessionHost;
    readonly inbox: SessionInboxHandle;
    readonly queue: SessionInputQueue;
    readonly records: SessionRecords | undefined;
    readonly scope: StubScope | undefined;
    readonly settle: (result: SessionRunResult) => void;
  },
): Promise<WorkflowEntryResult> {
  const { cursor, host, inbox, queue, records, scope, settle } = deps;
  const stepKey = sessionStepKeys(
    boot.generation === undefined ? boot.sessionId : `${boot.sessionId}:${boot.generation}`,
  );
  const steps: SessionStepRunner = { host, stepKey };
  const progress: SessionProgress = { caller: boot.caller };
  const handoff = host.moves ?? RETAINED;
  let result: WorkflowEntryResult = { output: "", isError: true };
  let loop: SessionLoopOutcome | undefined;
  let finalizing = false;
  let parked = false;
  try {
    result = await runServingToolStubs(host.toolStubs, scope, boot.sessionId, async () => {
      try {
        loop = await runSessionLoop(boot, {
          cursor,
          host,
          inbox,
          progress,
          queue,
          records,
          stepKey,
        });
      } finally {
        await inbox.dispose();
      }
      if (loop.kind === "transferred") {
        settle({ kind: "moved" });
        if (boot.anchor.kind !== "self") return { output: "" };
        result = await handoff.awaitAnchoredResult();
        return result;
      }
      finalizing = true;
      result = await finalizeSession(loop.outcome, {
        caller: progress.caller,
        cursor,
        sessionWritable: boot.sessionWritable,
        steps,
      });
      settle({ kind: "ended", outcome: endedOutcomeOf(loop.outcome, result) });
      return result;
    });
    return result;
  } catch (error) {
    if (error instanceof SessionParked) {
      parked = true;
      settle(error.result);
      return PARKED_RESULT;
    }
    if (!finalizing) {
      await finalizeSession(
        { error, kind: "failed", turnId: progress.turnId },
        { caller: progress.caller, cursor, sessionWritable: boot.sessionWritable, steps },
      );
    }
    throw createSafeOuterWorkflowError();
  } finally {
    await inbox.dispose();
    if (!parked) await reportResultToAnchor(boot, result, handoff, loop);
  }
}

function endedOutcomeOf(
  outcome: SessionTerminalOutcome,
  result: WorkflowEntryResult,
): "completed" | "failed" | "cancelled" {
  if (outcome.kind === "expired") return "cancelled";
  if (outcome.kind === "failed" || result.isError === true) return "failed";
  return "completed";
}

export async function failSession(input: {
  readonly error: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly step: SessionStepCall;
}): Promise<never> {
  const steps: SessionStepRunner = {
    host: { step: input.step },
    stepKey: sessionStepKeys(`${input.sessionId}:fail`),
  };
  let caller: TurnCaller | undefined;
  try {
    caller = await steps.host.step(
      "resolveInitialTurnCaller",
      { serializedContext: input.serializedContext },
      steps.stepKey("resolveInitialTurnCaller"),
    );
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
      steps,
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
    readonly records: SessionRecords | undefined;
    readonly stepKey: (name: SessionStepName) => string;
  },
): Promise<SessionLoopOutcome> {
  const { cursor, host, inbox, progress, queue, records, stepKey } = deps;
  const handoff = host.moves ?? RETAINED;
  const sessionTimeout = boot.sessionTimeoutControl;
  let idleWindow: number | "attempted" | undefined;
  const idle =
    records === undefined
      ? undefined
      : async (): Promise<void> => {
          if (inbox.hasPending() || !records.quiet()) return;
          if ((await host.next()) !== "park" || inbox.hasPending() || !records.quiet()) return;
          const wakes = [
            sessionTimeout?.getDeadline().getTime(),
            typeof idleWindow === "number" ? idleWindow : undefined,
          ].filter((at): at is number => at !== undefined);
          const wakeAt = wakes.length === 0 ? undefined : Math.min(...wakes);
          throw new SessionParked({
            kind: "parked",
            record: await records.keep(cursor),
            ...(wakeAt !== undefined && { wakeAt }),
          });
        };
  const execution = new SessionExecution({
    capabilities: boot.capabilities,
    cursor,
    host,
    inbox,
    queue,
    sessionId: boot.sessionId,
    stepKey,
    ...(idle !== undefined && { idle }),
  });
  records?.watch(execution);
  const settleControlDelivery = (settlement: ControlSettlement) =>
    cursor.advance((state) =>
      host.step(
        "settleControlDelivery",
        { ...state, settlement },
        stepKey("settleControlDelivery"),
      ),
    );
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
    await settleControlDelivery(settlement);
  };
  const settleUnstarted = async (): Promise<void> => {
    if (!started()) return;
    for (const settlement of unstarted.splice(0)) await settleControlDelivery(settlement);
  };
  const expired = (control?: ControlDelivery): SessionTerminalOutcome => ({
    kind: "expired",
    ...(control && { control }),
    ...(unstarted.length > 0 && { settles: unstarted.splice(0) }),
  });

  let prewarmedSandbox: SandboxRunning | undefined;
  const sandboxMayBeRunning = (): SandboxRunning | undefined =>
    readDurableSession(cursor.sessionState).sandboxState?.running ?? prewarmedSandbox;
  const sessionBusy = (): boolean =>
    queue.pendingCount > 0 ||
    workingTasks(sessionTaskTable(cursor)).length > 0 ||
    !isBetweenTurns(storedProjection(cursor.sessionState.snapshot.session.state));
  const stopSandboxOnceIdle = async (): Promise<void> => {
    while (!inbox.hasPending()) {
      if (!prewarmSettled) {
        const woken = await host.next({ wake: prewarming });
        if (woken === "input" || woken === "park") return;
        continue;
      }
      const running = sandboxMayBeRunning();
      if (running === undefined) idleWindow = undefined;
      if (running === undefined || idleWindow === "attempted" || sessionBusy()) return;
      if (inbox.awaitingHandover) {
        if ((await inbox.whenPendingOrHandoverSettled()) === "pending") return;
        continue;
      }
      if (running.idleTimeoutMs > 0) {
        idleWindow ??= host.now() + running.idleTimeoutMs;
        if ((await host.next({ until: idleWindow })) !== "due" || inbox.hasPending()) return;
      }
      idleWindow = "attempted";
      prewarmedSandbox = undefined;
      await cursor
        .advance(({ serializedContext, sessionState }) =>
          host.step(
            "stopIdleSandbox",
            { serializedContext, sessionState },
            stepKey("stopIdleSandbox"),
          ),
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
        host,
        stepKey,
        cursor,
        hasWorkingTasks: () => workingTasks(sessionTaskTable(cursor)).length > 0,
        ignore,
        inbox,
        queue,
        whileWaiting:
          idle === undefined
            ? stopSandboxOnceIdle
            : async () => {
                await stopSandboxOnceIdle();
                await idle();
              },
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
        await cancelWorkingTasks({ host, stepKey }, cursor, "turn-cancelled");
        if (next.origin !== undefined) {
          const control = controlDeliveryOf(next.origin);
          await settleControlDelivery({ control, outcome: "applied", source: "cancel" });
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
  const runTurn = async (
    payload: TurnStepPayload | undefined,
    pause?: TurnPause,
  ): Promise<TurnOutcome> => {
    const caller = progress.caller;
    const control = turnControl;
    turnControl = undefined;
    idleWindow = undefined;
    progress.turnId =
      payload?.control === undefined
        ? turnCoordinates(storedProjection(cursor.sessionState.snapshot.session.state)).turnId
        : undefined;
    const outcome = await execution.runTurn(payload, {
      caller,
      control,
      ...(pause !== undefined && { pause }),
    });
    if (control !== undefined) turnControl ??= nextTurnControl(control);
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
  const settleCancelledTurn = async (report: boolean, control?: ControlDelivery) => {
    const { caller } = progress;
    const settled = await cursor.advanceWithHistory(
      (state) =>
        host.step(
          "settleCancelledTurn",
          { ...state, control, reportUsage: report },
          stepKey("settleCancelledTurn"),
        ),
      { after: () => undefined, before: { at: "cancel", report, ...(control && { control }) } },
    );
    progress.caller = undefined;
    if (report && caller !== undefined) {
      const notification = { caller, sessionId: boot.sessionId };
      await host.step(
        "notifyCancelledTaskCaller",
        settled.usage === undefined ? notification : { ...notification, usage: settled.usage },
        stepKey("notifyCancelledTaskCaller"),
      );
    }
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
    }
    switch (boot.start.kind) {
      case "first-message":
        awaitingFirstInput = true;
        prewarmSettled = false;
        prewarming = cursor
          .advanceBeside(
            async ({ serializedContext, sessionState }) => {
              const prewarmed = await host.step(
                "prewarmSession",
                { serializedContext, sessionState },
                stepKey("prewarmSession"),
              );
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
      case "resume": {
        const { from } = boot.start;
        progress.caller ??=
          (from.at === "step" ? from.input?.delivery?.caller : undefined) ??
          (await host.step(
            "resolveInitialTurnCaller",
            { serializedContext: cursor.serializedContext },
            stepKey("resolveInitialTurnCaller"),
          ));
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
    const [actionResult, timerResult] = await host.all([
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
      await settleUnstarted();

      if (action.cancelled === true) {
        await settleCancelledTurn(progress.caller !== undefined, action.cancelledBy);
      } else if (action.settled !== undefined) {
        if (progress.caller !== undefined) {
          await host.step(
            "notifyTurnCaller",
            {
              caller: progress.caller,
              lifecycle: "parked",
              sessionId: boot.sessionId,
              settled: action.settled,
            },
            stepKey("notifyTurnCaller"),
          );
        }
        progress.caller = undefined;
      }

      const transferred = await tryCompactionHandoff();
      if (transferred !== undefined) return transferred;

      turnControl ??= createTurnControl();
      const next = await nextParkedActivity();

      switch (next.kind) {
        case "reset":
          return { kind: "terminal", outcome: resetOutcome(next.origin) };
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
            await cancelWorkingTasks({ host, stepKey }, cursor, "turn-cancelled", {
              turnCalls: true,
            });
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
