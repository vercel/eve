import { sleep } from "#compiled/@workflow/core/index.js";

import { prewarmSessionStep } from "#execution/session/prewarm-step.js";
import { exhaustedStepError, normalizeSerializableError } from "#execution/workflow-errors.js";
import type { SessionAuthContext, SessionCapabilities, TurnCaller } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME } from "#context/key-names.js";
import {
  dispatchCoordinationStep,
  publishDispatchedCallsStep,
} from "#execution/coordination-dispatch-step.js";
import { readDurableSession } from "#execution/durable-session-read.js";
import { mapHeldAnswersStep } from "#execution/proxied-deliver-step.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { admitHeldDeliveriesStep } from "#execution/session/admit-held-deliveries-step.js";
import { arrivalsOf, urgency } from "#execution/session/arrivals.js";
import type { SessionHandoff } from "#execution/session/handoff.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import { settleDuplicateDeliveryStep } from "#execution/session/settle-duplicate-delivery-step.js";
import { principalOf } from "#execution/session/principal.js";
import { on, type SchedulerEvent } from "#execution/session/scheduler/events.js";
import { next, type Next, type SessionReading } from "#execution/session/scheduler/next.js";
import {
  initialScheduler,
  turnOf,
  type Scheduler,
  type SessionEnd,
  type SessionStart,
  type Turn,
} from "#execution/session/scheduler/state.js";
import { settleControlDeliveryStep } from "#execution/session/settle-control-delivery-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { startTaskToolCallsStep } from "#execution/session/task-tool-tracing-step.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { turnStep } from "#execution/session/turn-step.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import {
  handleWorkflowToolRunMessage,
  isAppliedRunMessage,
  takeLeadingAppliedRunMessages,
} from "#execution/session-workflow-tool-run.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { answerTaskCancel, cancelWorkingTasks } from "#execution/tasks/session.js";
import {
  applyRunMessagesStep,
  type AppliedRunMessage,
} from "#execution/tools/workflow/apply-run-messages-step.js";
import { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import {
  runMessageBatchBudget,
  type WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { findBlockingWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { turnCoordinates } from "#protocol/session-projection.js";
import { sessionReading } from "#execution/session/session-reading.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
} from "#subagents/parent-notification.js";

export interface SessionLoopInput {
  readonly capabilities?: SessionCapabilities;
  readonly cursor: SessionStateCursor;
  readonly inbox: SessionInboxReader;
  readonly sessionId: string;
  /** This owner's run; timeouts sent by an earlier owner do not expire this one. */
  readonly ownerRunId: string;
  /** How the session moves to a fresh run or another deployment; without it, it stays. */
  readonly handoff?: Pick<
    SessionHandoff,
    "tryCompactionTransfer" | "tryPrewarmTransfer" | "tryTransfer"
  >;
  readonly sessionTimeoutControl?: SessionTimeoutControl;
  readonly admittedDeliveryKeys: readonly string[];
  /** What the session does before it first waits on its inbox; a prewarmed session waits. */
  readonly start?: SessionStart;
  /** The delegated caller the session's first turn answers. */
  readonly caller?: TurnCaller;
}

/**
 * Runs a session inside its owning workflow: performs what the scheduler (`scheduler/next.ts`)
 * decides, and hands back what came of it. Everything the session decides is there; everything
 * here is what only the world can finish: steps, reads of the inbox, signals, and timers.
 */
export class SessionLoop {
  readonly #input: SessionLoopInput;
  #state: Scheduler;
  /** The turn's controls, prepared before it begins, so the first step's signals reach it. */
  #prepared: TurnControl | undefined;
  #turn: TurnSignals | undefined;
  /** The turn a running turn's step runs: a crash outside one is attributed to the latest turn. */
  #turnId: string | undefined;
  /** Work that started beside the session's first action, which joins once that action ends. */
  #startup: Promise<void> | undefined;
  /** A prewarmed session's prewarm step, which runs beside its wait for a first message. */
  #prewarming: Promise<void> | undefined;
  #prewarmSettled = true;
  /** What the prewarm step prepared is kept only while the session still waits for its first input. */
  #awaitingFirstInput = false;

  constructor(input: SessionLoopInput) {
    this.#input = input;
    this.#state = initialScheduler(
      input.start ?? { kind: "first-message" },
      input.caller,
      input.admittedDeliveryKeys,
    );
  }

  /** The delegated caller still owed this session's reply. */
  get caller(): TurnCaller | undefined {
    return this.#state.caller;
  }

  get turnId(): string | undefined {
    return this.#turnId;
  }

  /**
   * Runs the session until it ends, or moves to another run. `startup` runs beside the session's
   * first action: its first turn, or, for a successor of a settled session, nothing. It joins once
   * that action ends, and its failure fails the session first.
   */
  async run(
    options: { readonly control?: TurnControl; readonly startup?: Promise<void> } = {},
  ): Promise<SessionEnd> {
    this.#prepared = options.control;
    this.#startup = options.startup;
    if ((this.#input.start ?? { kind: "first-message" }).kind === "first-message") this.#prewarm();
    try {
      if (this.#input.start?.kind === "parked") await this.#joinStartup();
      const ended = await this.#drive((asks) => asks.kind === "end");
      if (ended.kind !== "end")
        throw new Error("The session loop stopped before the session ended.");
      return ended.end;
    } catch (error) {
      await this.#joinStartup();
      throw error;
    } finally {
      this.#awaitingFirstInput = false;
      // The session must not end and clean up before a sandbox the prewarm step is still starting.
      await this.#prewarming;
    }
  }

  /**
   * Runs the prewarm step beside the wait, so a first message starts its turn without waiting for
   * it. Provider `start()` upserts by session id, so a turn that opens the sandbox meanwhile
   * reaches the one being prewarmed.
   */
  #prewarm(): void {
    this.#awaitingFirstInput = true;
    this.#prewarmSettled = false;
    this.#prewarming = this.#input.cursor
      .advanceBeside(
        ({ serializedContext, sessionState }) =>
          prewarmSessionStep({ serializedContext, sessionState }),
        () => this.#awaitingFirstInput,
      )
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#prewarmSettled = true;
      });
  }

  async #joinStartup(): Promise<void> {
    const startup = this.#startup;
    this.#startup = undefined;
    await startup;
  }

  async #drive(stopsAfter: (asks: Next) => boolean): Promise<Next> {
    try {
      while (true) {
        const decision = next(this.#state, readSession(this.#input));
        this.#state = decision.state;
        if (decision.rearm) this.#turn?.rearm();
        if (decision.asks.kind === "end") await this.#joinStartup();
        const event = await this.#perform(decision.asks);
        if (decision.asks.kind === "end-turn") await this.#joinStartup();
        if (event !== undefined) this.#state = on(this.#state, event);
        // The turn's controls follow the scheduler: a turn that stops aborts the step it runs.
        if (turnOf(this.#state)?.stopping === true) this.#turn?.stop();
        if (stopsAfter(decision.asks)) return decision.asks;
      }
    } catch (error) {
      this.#turn?.close();
      this.#turn = undefined;
      throw error;
    }
  }

  async #perform(asks: Next): Promise<SchedulerEvent | undefined> {
    const { cursor, inbox } = this.#input;
    // Whatever the session does besides waiting may change it under the prewarm step.
    if (asks.kind !== "wait" && asks.kind !== "check-session-timeout" && asks.kind !== "prewarm")
      this.#awaitingFirstInput = false;
    switch (asks.kind) {
      case "check-session-timeout": {
        const timer = this.#input.sessionTimeoutControl;
        if (this.#state.held.entries.length > 0 || inbox.hasPending()) timer?.recordActivity();
        return {
          kind: "session-timeout-checked",
          expired: timer === undefined || (await timer.handleTimerElapsed()) === "expired",
        };
      }
      case "settle-duplicate":
        await cursor.advance((state) =>
          settleDuplicateDeliveryStep({ ...state, delivery: asks.delivery }),
        );
        return undefined;
      case "turn-started": {
        const control = this.#prepared ?? createTurnControl();
        this.#prepared = undefined;
        this.#turn = new TurnSignals(
          this.#input,
          asks.turn,
          control,
          () => this.#state.admittedDeliveryKeys,
        );
        // A step that fails can leave the turn it opened out of the cursor, so the turn is read
        // before the step runs. Controls run between turns.
        this.#turnId = asks.turn.control
          ? undefined
          : turnCoordinates(storedProjection(cursor.sessionState.snapshot.session.state)).turnId;
        return undefined;
      }
      case "step": {
        const signals = this.#turn!;
        // A step that fails every attempt fails its turn, not the session; only a failed recovery
        // ends the session. What fails once a step has returned, such as adopting its state, is
        // not the step's failure, so it is not recovered.
        const result = await cursor.advanceWithHistory((state) => {
          const run = (recover?: { readonly error: unknown }) =>
            turnStep({
              ...state,
              abortSignal: signals.cancellation,
              caller: asks.caller,
              input: asks.input,
              recover,
              steeringSignal: signals.steering,
            });
          return run().catch((error: unknown) =>
            run({ error: normalizeSerializableError(exhaustedStepError(error)) }),
          );
        });
        const { stateDelta: _delta, ...end } = result;
        // What arrived while the step ran, the turn's boundary admits. A step that raises a
        // request publishes it before it returns, so they may answer it.
        const arrivals = inbox
          .drain()
          .flatMap((payload) => arrivalsOf(payload, this.#input.ownerRunId));
        return { arrivals, kind: "stepped", result: end };
      }
      case "end-turn": {
        this.#input.sessionTimeoutControl?.recordActivity();
        this.#turn?.close();
        this.#turn = undefined;
        this.#turnId = undefined;
        return undefined;
      }
      case "route": {
        const routed = await cursor.advance((state) =>
          routeDeliverToChildren({ delivery: asks.delivery, ...state }),
        );
        if (routed.kind === "cancel-turn")
          return { kind: "routed", routed: { kind: "cancel-turn" } };
        if (routed.remainder === undefined) return { kind: "routed", routed: { kind: "consumed" } };
        return { kind: "routed", routed: { delivery: routed.remainder, kind: "remainder" } };
      }
      case "map-answers": {
        const mapped = await cursor.advance((state) =>
          mapHeldAnswersStep({
            delivery: asks.delivery,
            requestIds: [...asks.requestIds],
            ...state,
          }),
        );
        return mapped.delivery === undefined
          ? { kind: "mapped" }
          : { delivery: mapped.delivery, kind: "mapped" };
      }
      case "apply-run-messages": {
        const budget = runMessageBatchBudget();
        for (const message of asks.messages.slice(1)) budget(message);
        const messages = asks.fromInbox
          ? [...asks.messages, ...takeLeadingAppliedRunMessages(inbox, budget)]
          : asks.messages;
        return {
          cancelled: await this.#applyRunMessages(messages, asks.canCancelTurn),
          kind: "applied",
        };
      }
      case "handle-run-message": {
        const result = await handleWorkflowToolRunMessage({ cursor, message: asks.message });
        return {
          at: Date.now(),
          kind: "handled",
          message: asks.message,
          ...(result && { result }),
        };
      }
      case "dispatch": {
        const dispatched = await cursor.advance((state) =>
          dispatchCoordinationStep({
            workflowToolRunOwner: {
              inbox: sessionInboxHookToken(sessionCommandHookToken(this.#input.sessionId)),
            },
            ...state,
          }),
        );
        const { executing, refused, started } = dispatched.pending;
        if (executing.length > 0 || refused.length > 0 || started.length > 0) {
          await cursor.advance((state) =>
            publishDispatchedCallsStep({ ...state, pending: dispatched.pending }),
          );
        }
        return { at: Date.now(), kind: "dispatched", results: dispatched.results };
      }
      case "start-task-calls": {
        // The step's clock anchors deadlines even if answering a cancel delays the next wait.
        const startedAtMs = await startTaskToolCallsStep();
        const answers = [];
        for (const call of asks.calls) {
          if (call.kind === TASK_WAIT_TOOL_NAME) continue;
          answers.push({ result: await answerTaskCancel(cursor, call), at: Date.now() });
        }
        return { answers, kind: "task-calls-started", startedAtMs };
      }
      case "interrupt-runs": {
        // Aborts the `abortSignal` of each workflow tool call without a result yet.
        const state = cursor.sessionState.snapshot.session.state;
        const runs = asks.callIds.flatMap((callId) => {
          const run = findBlockingWorkflowToolRun(state, callId);
          return run === undefined ? [] : [run.address];
        });
        await Promise.all(runs.map((run) => interruptWorkflowToolRun(run)));
        return undefined;
      }
      case "admit-held":
        await cursor.advance((state) =>
          admitHeldDeliveriesStep({
            ...state,
            controls: asks.controls,
            deliveries: asks.deliveries,
          }),
        );
        return undefined;
      case "wait":
        return await this.#wait(asks);
      case "settle-control":
        await cursor.advance((state) =>
          settleControlDeliveryStep({ ...state, settlement: asks.settlement }),
        );
        return undefined;
      case "report-dropped":
        await reportDroppedWirePayloadStep({ detail: asks.detail, family: "session-inbox" });
        return undefined;
      case "cancel-tasks":
        await cancelWorkingTasks(cursor, asks.reason, { turnCalls: asks.turnCalls === true });
        return undefined;
      case "fail":
        throw new Error(asks.message);
      case "take-turn": {
        const { handoff } = this.#input;
        if (handoff === undefined) return { kind: "transfer", transferred: false };
        const transfer = await handoff.tryTransfer(asks.selection, this.#transferState());
        return { kind: "transfer", transferred: transfer.kind === "transferred" };
      }
      case "hand-off": {
        const { handoff } = this.#input;
        if (handoff === undefined) return { kind: "transfer", transferred: false };
        const transfer = await handoff.tryCompactionTransfer(this.#transferState());
        return { kind: "transfer", transferred: transfer.kind === "transferred" };
      }
      case "prewarm": {
        const { handoff, sessionTimeoutControl } = this.#input;
        // A prewarm step still starting a sandbox keeps the session here: a successor could end
        // the session and clean up before that start lands.
        if (handoff === undefined || !this.#prewarmSettled)
          return { kind: "transfer", transferred: false };
        const transfer = await handoff.tryPrewarmTransfer(
          this.#transferState(),
          asks.targetDeploymentId,
          sessionTimeoutControl?.getDeadline(),
        );
        return { kind: "transfer", transferred: transfer.kind === "transferred" };
      }
      case "settle-cancelled-turn": {
        this.#input.sessionTimeoutControl?.recordActivity();
        const { caller, control } = asks;
        const settled = await cursor.advanceWithHistory((state) =>
          settleCancelledTurnStep({ ...state, control, reportUsage: caller !== undefined }),
        );
        if (caller !== undefined) {
          const notification = { caller, sessionId: this.#input.sessionId };
          await notifyCancelledTaskCallerStep(
            settled.usage === undefined ? notification : { ...notification, usage: settled.usage },
          );
        }
        return undefined;
      }
      case "notify-parked":
        await notifyTurnCallerStep({
          caller: asks.caller,
          lifecycle: "parked",
          sessionId: this.#input.sessionId,
          settled: asks.settled,
        });
        return undefined;
      case "end":
        return undefined;
    }
  }

  /**
   * Applies run messages in order: those the session applies as it reads them in one step per
   * batch, and each other one alone, between them. Hooks on their events may cancel the turn.
   */
  async #applyRunMessages(
    messages: readonly WorkflowToolRunMessage[],
    canCancelTurn: boolean,
  ): Promise<boolean> {
    const { cursor } = this.#input;
    let cancelled = false;
    let batch: AppliedRunMessage[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const applied = await cursor.advance((state) =>
        applyRunMessagesStep({ ...state, canCancelTurn, messages: batch }),
      );
      cancelled ||= applied.cancelled;
      batch = [];
    };
    for (const message of messages) {
      if (isAppliedRunMessage(message)) {
        batch.push(message);
        continue;
      }
      await flush();
      await handleWorkflowToolRunMessage({ cursor, message });
    }
    await flush();
    return canCancelTurn && cancelled;
  }

  /** Waits for what arrives, or for a task wait's timer while a turn waits on its calls. */
  async #wait(asks: Extract<Next, { kind: "wait" }>): Promise<SchedulerEvent> {
    const { inbox } = this.#input;
    // Registered while parked, so the next turn's first step is not held behind its abort hooks.
    this.#prepared ??= createTurnControl();
    if (asks.timeout !== undefined && !inbox.hasPending()) {
      const { callId, deadlineMs } = asks.timeout;
      const inboxReady = inbox.whenPending().then(() => false);
      const elapsed = await Promise.race([
        inboxReady,
        sleep(new Date(deadlineMs)).then(() => true),
      ]);
      if (elapsed) return { callId, kind: "timed-out" };
    }
    const payload = await inbox.next();
    if (payload === undefined) return { kind: "closed" };
    return { arrivals: arrivalsOf(payload, this.#input.ownerRunId), kind: "arrived" };
  }

  #transferState() {
    const { cursor } = this.#input;
    return {
      admittedDeliveryKeys: this.#state.admittedDeliveryKeys,
      history: cursor.history,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    };
  }
}

/**
 * A turn's signals: a cancel aborts the step that runs, and the turn's own person's message
 * interrupts its generation, the moment either arrives. The inbox's pump signals them; the
 * payloads stay in the inbox, and the turn admits them in order at its next boundary.
 */
class TurnSignals {
  readonly #input: SessionLoopInput;
  readonly #admittedDeliveryKeys: () => readonly string[];
  readonly #turn: Pick<Turn, "control" | "steerer" | "turnId">;
  readonly #cancellation: AbortController;
  #steering: AbortController;
  readonly #unsubscribeInterrupt: () => void;
  #unsubscribeDelivery: () => void;

  constructor(
    input: SessionLoopInput,
    turn: Pick<Turn, "control" | "steerer" | "turnId">,
    control: TurnControl,
    admittedDeliveryKeys: () => readonly string[],
  ) {
    this.#input = input;
    this.#admittedDeliveryKeys = admittedDeliveryKeys;
    this.#turn = turn;
    this.#cancellation = control.cancellation;
    this.#steering = control.steering;
    this.#unsubscribeInterrupt = input.inbox.onInterrupt((payload) => {
      if (this.#urgency(payload) === "stop") this.stop();
    });
    this.#unsubscribeDelivery = input.inbox.onDelivery(this.#interrupt);
  }

  get cancellation(): AbortSignal {
    return this.#cancellation.signal;
  }

  get steering(): AbortSignal {
    return this.#steering.signal;
  }

  stop(): void {
    if (this.#cancellation.signal.aborted) return;
    this.#cancellation.abort(new TurnCancelledError());
  }

  /**
   * The turn looked for what steers it, so what it saw must not interrupt its next step: a
   * steering signal that fired starts fresh. Replaying the unread inbox keeps what arrived since
   * attached to the next generation.
   */
  rearm(): void {
    if (!this.#steering.signal.aborted) return;
    this.#unsubscribeDelivery();
    this.#steering = new AbortController();
    this.#unsubscribeDelivery = this.#input.inbox.onDelivery(this.#interrupt);
  }

  close(): void {
    this.#unsubscribeInterrupt();
    this.#unsubscribeDelivery();
  }

  readonly #interrupt = (
    payload: Parameters<Parameters<SessionInboxReader["onDelivery"]>[0]>[0],
  ): void => {
    if (this.#urgency(payload) === "interrupt") this.#steering.abort();
  };

  #urgency(payload: Parameters<typeof urgency>[0]) {
    return urgency(payload, this.#turn, {
      childrenAsk: this.#input.cursor.sessionState.hasProxyInputRequests,
      admittedDeliveryKeys: this.#admittedDeliveryKeys(),
    });
  }
}

/** What the scheduler reads of the session now, from its cursor, its inbox, and the clock. */
function readSession(input: SessionLoopInput): SessionReading {
  const { capabilities, cursor, inbox } = input;
  const { serializedContext } = cursor;
  const earlier = earlierRemoteCaller(serializedContext);
  return sessionReading(readDurableSession(cursor.sessionState).state, {
    canAskPeople:
      capabilities?.requestInput === true || hasDelegatedCallerContext(serializedContext),
    ...(earlier !== undefined && { earlierRemoteCaller: earlier }),
    inboxPending: inbox.hasPending(),
    now: Date.now(),
    principal: principalOf(
      serializedContext[AuthKey.name] as SessionAuthContext | null | undefined,
    ),
  });
}

/** True when a delegating parent (local or remote) receives this session's input requests. */
export function hasDelegatedCallerContext(serializedContext: Record<string, unknown>): boolean {
  if (earlierRemoteCaller(serializedContext) !== undefined) return false;
  if (serializedContext["eve.sessionCallback"] !== undefined) return true;
  const channel = serializedContext["eve.channel"];
  return (
    typeof channel === "object" && channel !== null && Reflect.get(channel, "kind") === "subagent"
  );
}

/** The protocol of a remote caller this session can't relay requests to, when it has one. */
function earlierRemoteCaller(serializedContext: Record<string, unknown>): number | undefined {
  const version = serializedContext[EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME];
  return typeof version === "number" ? version : undefined;
}
