import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  SessionAuthContext,
  SessionCapabilities,
} from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { readAnswerer } from "#execution/session/answerer.js";
import {
  isSteeringDelivery,
  type SessionInputQueue,
  type SteerableTurn,
} from "#execution/session/input-queue.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import {
  InboxWaitEnded,
  type SessionInboxPayload,
  type SessionInboxReader,
} from "#execution/session-inbox/inbox.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type {
  DurableStepResult,
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { turnStep } from "#execution/session/turn-step.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";
import {
  answerTaskInput,
  applyTaskDeadline,
  applyTaskOwnerUpdate,
  applyTaskReport,
  cancelTasks,
  endTaskWaits,
  interruptAttachedCalls,
  startPendingAgentTasks,
} from "#tasks/owner-body.js";
import { hasPendingTaskInput } from "#tasks/input.js";
import { flushUnsentCallerEvents } from "#subagents/remote/unsent-caller-events.js";
import type { TaskWaitRegistration } from "#tasks/wait.js";
import { DISMISSED_CALL_GRACE_MS, WaitTimers } from "#tasks/wait-timers.js";
import { hasPendingDetachedWork, readTaskCreator } from "#tasks/results.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RunMode } from "#shared/run-mode.js";
import type { RuntimeActionResult, RuntimeSubagentChildResult } from "#shared/action-types.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

export interface SessionExecutionInput {
  readonly capabilities?: SessionCapabilities;
  readonly cursor: SessionStateCursor;
  readonly inbox: SessionInboxReader;
  readonly mode: RunMode;
  readonly queue: SessionInputQueue;
  readonly sessionId: string;
}

/**
 * Executes conversational turns inside the owning session workflow: runs
 * `turnStep`, services the inbox at committed boundaries, coordinates waits,
 * and settles locally. There is no child run and no transport protocol.
 */
export class SessionExecution {
  private readonly input: SessionExecutionInput;

  constructor(input: SessionExecutionInput) {
    this.input = input;
  }

  get cursor(): SessionStateCursor {
    return this.input.cursor;
  }

  /**
   * Runs one turn. `callerCallId` names the delegated call the session is
   * answering, whose owner's steering messages steer this turn; it defaults to
   * the caller of the delivery that starts the turn. Only the turn's own
   * principal steers it; anyone else's delivery waits in the queue until the
   * turn ends.
   */
  async runTurn(
    delivery: TurnStepPayload | undefined,
    callerCallId: string | undefined = delivery?.delivery?.caller?.callId,
  ): Promise<TurnOutcome> {
    const turn = new ActiveTurn(this.input, {
      callerCallId,
      principal: turnPrincipal(delivery, this.input.cursor),
    });
    try {
      return await this.runTurnSteps(turn, delivery);
    } finally {
      turn.dispose();
    }
  }

  private async runTurnSteps(
    turn: ActiveTurn,
    delivery: TurnStepPayload | undefined,
  ): Promise<TurnOutcome> {
    let nextStepInput: TurnStepPayload | undefined = delivery;

    while (true) {
      const { cursor } = this.input;
      const result: DurableStepResult = await turnStep(
        cursor.createStepInput(nextStepInput, {
          abortSignal: turn.signal,
          steeringSignal: turn.steeringSignal,
        }),
      );
      const pendingCallIds =
        result.action === "park" ? result.pendingCoordinationCallIds : undefined;
      const turnCompleted = result.action === "park" && result.settled !== undefined;

      await cursor.apply({
        serializedContext: result.serializedContext,
        sessionState: result.sessionState,
      });
      // The only emitter that does not flush its own: a remote caller must see
      // what the step asked or resolved before the result or a later answer.
      await flushUnsentCallerEvents(cursor);
      await turn.admitBoundary();
      turn.resetSteering();

      if (result.action === "cancelled") return await this.finishCancelledTurn(turn);
      if (!turnCompleted && turn.signal.aborted && pendingCallIds === undefined) {
        return await this.finishCancelledTurn(turn);
      }

      if (result.action === "done") {
        return {
          isError: result.isError,
          kind: "done",
          output: result.output ?? "",
          usage: result.usage,
          usageDelta: result.usageDelta,
        };
      }

      if (pendingCallIds !== undefined && result.action === "park") {
        const dispatched = await dispatchCoordinationStep({
          action: result.action,
          callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
          workflowToolRunOwner: {
            inbox: sessionInboxHookToken(sessionCommandHookToken(this.input.sessionId)),
          },
          sessionWritable: cursor.sessionWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        const initialResults = [
          ...(await applyTaskOwnerUpdate(cursor, dispatched)),
          ...(await startPendingAgentTasks(cursor)),
        ];
        const initialAcceptedAtMs = initialResults.length === 0 ? undefined : Date.now();

        const runtimeResults = await this.waitForRuntimeActionResults({
          initialAcceptedAtMs,
          initialResults,
          pendingCallIds,
          taskWaits: dispatched.taskWaits ?? [],
          turn,
        });
        if (runtimeResults === "cancelled") return await this.finishCancelledTurn(turn);
        // Steering accepted during the wait joins the same step as the results,
        // and receipts, of the calls it waited on.
        nextStepInput = { delivery: await turn.takeSteering(), runtimeResults };
        continue;
      }

      if (result.action === "park") {
        // A failed turn stops the work it started before it reports, so a
        // task-mode run never waits on tasks it just cancelled.
        if (result.settled?.isError === true) {
          await cancelTasks(cursor, { kind: "turn", turnId: turn.turnId });
        }
        const canPark =
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && this.input.capabilities?.requestInput === true) ||
          this.input.mode === "conversation" ||
          // A task-mode run waits for its detached tasks, then a result turn ends it.
          (result.settled !== undefined &&
            hasPendingDetachedWork(cursor.sessionState.snapshot.session.state));
        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);
        return {
          authorizationAttemptIds: result.authorizationAttemptIds,
          kind: "park",
          settled: result.settled,
        };
      }

      const steering = await turn.takeSteering();
      nextStepInput = steering === undefined ? undefined : { delivery: steering };
    }
  }

  async handleWorkflowMessage(
    message: WorkflowToolRunMessage,
  ): Promise<RuntimeActionResult | undefined> {
    return await handleWorkflowToolRunMessage({
      cursor: this.input.cursor,
      message,
    });
  }

  /**
   * Ends a cancelled or expired turn: its waits end without results, and
   * every working task is cancelled, whichever turn started it. Idle tasks
   * stay available.
   */
  private async finishCancelledTurn(turn: ActiveTurn): Promise<TurnOutcome> {
    const { cursor } = this.input;
    await endTaskWaits(cursor, { reason: "turn-cancelled" });
    await cancelTasks(cursor, { kind: "all" });
    return turn.expired
      ? { cancelled: true, expired: true, kind: "park" }
      : { cancelled: true, kind: "park" };
  }

  /**
   * Waits for every call in the batch; detached calls already returned their
   * receipts. A `task_wait` ends at its timeout. A steering message, in any
   * session, ends every attached call still in flight (a `task_wait` returns
   * `interrupted`, an attached workflow tool is cancelled), except calls whose
   * question it dismissed: those resolve on their own, or are stopped after
   * a grace period. Each ended call resolves at once with its own tool result.
   */
  private async waitForRuntimeActionResults(input: {
    readonly initialAcceptedAtMs: number | undefined;
    readonly initialResults: readonly RuntimeActionResult[];
    readonly pendingCallIds: readonly string[];
    readonly taskWaits: readonly TaskWaitRegistration[];
    readonly turn: ActiveTurn;
  }): Promise<RuntimeActionResultStepInput | "cancelled"> {
    const { cursor } = this.input;
    const results: RuntimeActionResult[] = [...input.initialResults];
    const acceptedAtMsByCallId = new Map<string, number>();
    if (input.initialAcceptedAtMs !== undefined) {
      for (const result of results)
        acceptedAtMsByCallId.set(result.callId, input.initialAcceptedAtMs);
    }
    const unresolved = () =>
      input.pendingCallIds.filter((callId) => !results.some((result) => result.callId === callId));
    const waitCallIds = new Set(input.taskWaits.map(({ callId }) => callId));
    const timers = new WaitTimers(
      input.taskWaits.flatMap(({ callId, timeoutMs }) =>
        timeoutMs === undefined || !unresolved().includes(callId) ? [] : [{ callId, timeoutMs }],
      ),
    );
    const accept = (accepted: readonly RuntimeActionResult[]) => {
      const acceptedAtMs = Date.now();
      results.push(...accepted);
      for (const result of accepted) acceptedAtMsByCallId.set(result.callId, acceptedAtMs);
      timers.disarm(accepted.map((result) => result.callId));
    };
    // Calls a steering message left running because it dismissed their question.
    const dismissed = new Set<string>();

    while (true) {
      const ready = resolveRuntimeActionResultsForCallIds({
        pendingCallIds: input.pendingCallIds,
        results,
      });
      if (ready !== undefined) {
        return {
          acceptedAtMsByCallId: Object.fromEntries(
            ready.map((result) => [result.callId, acceptedAtMsByCallId.get(result.callId)!]),
          ),
          results: ready,
        };
      }

      const next = await input.turn.nextRuntimeEvent({ timer: timers.next() });
      if (next === "cancelled") return next;
      if (next.kind === "runtime-action-result") {
        accept(next.results);
        continue;
      }
      if (next.kind === "timeout") {
        timers.disarm([next.callId]);
        if (!unresolved().includes(next.callId)) continue;
        // A timeout ends its own `task_wait`, and stops a dismissed call past its grace period.
        accept(
          waitCallIds.has(next.callId)
            ? await endTaskWaits(cursor, { callIds: [next.callId], reason: "timed_out" })
            : await interruptAttachedCalls(cursor, [next.callId]),
        );
        continue;
      }
      for (const callId of next.dismissedCallIds) {
        if (dismissed.has(callId) || !unresolved().includes(callId)) continue;
        dismissed.add(callId);
        timers.arm(callId, DISMISSED_CALL_GRACE_MS);
      }
      const ended = unresolved().filter((callId) => !dismissed.has(callId));
      if (ended.length > 0) accept(await interruptAttachedCalls(cursor, ended));
    }
  }
}

/** What interrupted a runtime wait. */
type WaitInterruption =
  | {
      /** A steering message, with the calls whose dismissible question it dismissed. */
      readonly kind: "steer";
      readonly dismissedCallIds: readonly string[];
    }
  /** A `task_wait` timeout, or a dismissed call's grace period. */
  | { readonly kind: "timeout"; readonly callId: string };

interface RuntimeResultEvent {
  readonly kind: "runtime-action-result";
  /** Produced by the owner's own task table, never read from the inbox as is. */
  readonly results: readonly RuntimeActionResult[];
}

type RuntimeEvent = RuntimeResultEvent | WaitInterruption | "cancelled";

/**
 * Admission policy, cancellation, and steering for one active turn.
 * Deliveries admitted while a model step runs stay in the shared queue until
 * the turn reaches a committed boundary; a runtime-action wait routes them
 * eagerly so a proxied child can receive the answer it is blocked on.
 *
 * The pump signals cancellation and eligible steering immediately. Cancellation
 * aborts the turn; steering only interrupts generation before assistant output
 * or local tool execution. Both retain ordered admission at the next boundary.
 * The session's expiry cancels the turn too.
 */
class ActiveTurn {
  private readonly admitted = new Set<number>();
  private readonly routedToChildren = new Set<number>();
  /** Calls whose question each routed delivery dismissed, by admission sequence. */
  private readonly dismissedBy = new Map<number, readonly string[]>();
  /** Steering deliveries that already interrupted a runtime wait. */
  private readonly interruptedBy = new Set<number>();
  private readonly runtimeResults: RuntimeResultEvent[] = [];
  private readonly controller = new AbortController();
  readonly turnId: string;
  private readonly input: SessionExecutionInput;
  private readonly turn: SteerableTurn;
  private readonly unsubscribe: () => void;
  private unsubscribeDelivery: () => void;
  private steeringController = new AbortController();
  private stopReason: StopReason | undefined;

  constructor(input: SessionExecutionInput, turn: SteerableTurn) {
    this.input = input;
    this.turn = turn;
    this.turnId = activeTurnId(input.cursor.sessionState.emissionState);
    this.unsubscribe = input.inbox.onInterrupt((payload) => this.stopFor(payload));
    this.unsubscribeDelivery = input.inbox.onDelivery(this.signalSteering);
  }

  /** Whether the session expired during the turn; it ends once the turn does. */
  get expired(): boolean {
    return this.stopReason === "expired";
  }

  private readonly signalSteering = (payload: SessionInboxPayload): void => {
    let delivery;
    try {
      delivery = decodeSessionInboxPayload(payload);
    } catch {
      return;
    }
    if (
      delivery.kind === "deliver" &&
      isSteeringDelivery(delivery, this.turn) &&
      // A message may answer a task's question, so routing decides before it steers.
      !hasPendingTaskInput(this.input.cursor.sessionState.snapshot.session) &&
      delivery.payloads.some(
        (value) => value.message !== undefined && value.inputResponses === undefined,
      )
    )
      this.steeringController.abort();
  };

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeDelivery();
  }

  get steeringSignal(): AbortSignal {
    return this.steeringController.signal;
  }

  resetSteering(): void {
    if (!this.steeringController.signal.aborted) return;
    this.unsubscribeDelivery();
    this.steeringController = new AbortController();
    // Admission can yield while new deliveries are pumped. Replaying the
    // unread inbox keeps those arrivals attached to the next generation.
    this.unsubscribeDelivery = this.input.inbox.onDelivery(this.signalSteering);
  }

  /** Admits everything the pump accepted while the last step ran. */
  async admitBoundary(): Promise<void> {
    const pending = this.input.inbox.drain();
    for (const payload of pending) await this.admit(payload);
  }

  /**
   * Steering admitted during this turn, coalesced, once every admitted
   * delivery's answers reached the tasks that asked. A delivery that does
   * not steer this turn stays queued until the turn ends.
   */
  async takeSteering(): Promise<DeliverHookPayload | undefined> {
    await this.routeAdmittedToChildren();
    if (this.signal.aborted) return undefined;
    const selection = this.input.queue.takeSteering(this.admitted, this.turn);
    if (selection === undefined) return undefined;
    for (const sequence of selection.sequences) this.admitted.delete(sequence);
    return selection.delivery;
  }

  /**
   * Next runtime result, admitting inbox traffic while waiting. A steering
   * message that remains after routing interrupts the wait once; results the
   * owner already produced come first. `timer` interrupts the wait unless an
   * inbox payload was accepted first.
   */
  async nextRuntimeEvent(
    options: { readonly timer?: Promise<string> } = {},
  ): Promise<RuntimeEvent> {
    while (true) {
      if (this.signal.aborted) return "cancelled";
      const event = this.runtimeResults.shift();
      if (event !== undefined) return event;
      // Deliveries admitted at the step boundary may answer a question first.
      await this.routeAdmittedToChildren();
      if (this.signal.aborted) return "cancelled";
      const steering = this.takeWaitSteering();
      if (steering !== undefined) return steering;
      const payload =
        options.timer === undefined
          ? await this.input.inbox.next()
          : await this.input.inbox.next(options.timer);
      if (payload instanceof InboxWaitEnded) return { callId: payload.value, kind: "timeout" };
      if (payload === undefined)
        throw new Error("Session inbox closed before runtime actions completed.");
      await this.admit(payload);
      await this.routeAdmittedToChildren();
    }
  }

  /**
   * Steering admitted during a runtime wait that has not interrupted it yet.
   * A message that answered a pending question was consumed by routing and
   * never steers.
   */
  private takeWaitSteering(): WaitInterruption | undefined {
    const dismissedCallIds: string[] = [];
    let steered = false;
    for (const sequence of this.admitted) {
      if (this.interruptedBy.has(sequence) || !this.routedToChildren.has(sequence)) continue;
      const delivery = this.input.queue.delivery(sequence);
      if (
        delivery === undefined ||
        !isSteeringDelivery(delivery, this.turn) ||
        !delivery.payloads.some((payload) => payload.message !== undefined)
      ) {
        continue;
      }
      this.interruptedBy.add(sequence);
      dismissedCallIds.push(...(this.dismissedBy.get(sequence) ?? []));
      steered = true;
    }
    return steered ? { dismissedCallIds, kind: "steer" } : undefined;
  }

  /**
   * Stops the turn for an interrupt that applies to it: a reset, the
   * session's expiry, or a cancel whose `turnId`, if any, names this turn.
   */
  private stopFor(payload: SessionInboxPayload): void {
    switch (payload.kind) {
      case "reset":
        this.abort("cancelled");
        return;
      case "cancel":
        if (payload.turnId === undefined || payload.turnId === this.turnId) this.abort("cancelled");
        return;
      case "session-timeout":
        // A previous owner's timer may fire after handoff; only this owner's deadline counts.
        if (payload.ownerRunId === getWorkflowMetadata().workflowRunId) this.abort("expired");
        return;
    }
  }

  private async admit(value: SessionInboxPayload): Promise<void> {
    const admitted = await admitSessionInboxPayload(value, this.input);
    switch (admitted.kind) {
      case "delivery":
        this.admitted.add(admitted.admission.sequence);
        return;
      case "runtime-action-result": {
        // Only a child's report settles a task; the owner derives the call's result.
        const childResults = admitted.payload.results.filter(
          (result): result is RuntimeSubagentChildResult =>
            result.kind === "subagent-result" && result.origin === "child",
        );
        if (childResults.length > 0) {
          await this.applyTaskReport({
            kind: "runtime-action-result",
            results: childResults,
            source: admitted.payload.source,
          });
        }
        return;
      }
      case "workflow": {
        // Handled on admission, even between model steps: a detached run's
        // outcome, question, or progress must not wait for a runtime wait.
        const result = await handleWorkflowToolRunMessage({
          cursor: this.input.cursor,
          message: admitted.message,
        });
        if (result !== undefined) {
          this.runtimeResults.push({ kind: "runtime-action-result", results: [result] });
        }
        return;
      }
      case "task-report":
        await this.applyTaskReport(admitted.payload);
        return;
      case "task-deadline":
        this.acceptOwnResults(await applyTaskDeadline(this.input.cursor, admitted.signal));
        return;
      case "cancel":
        this.stopFor(value);
        return;
      case "consumed":
        return;
    }
  }

  /**
   * Task reports apply as soon as they are admitted, even between model
   * steps, so a held cancel reaches a late-starting child.
   */
  private async applyTaskReport(payload: Parameters<typeof applyTaskReport>[1]): Promise<void> {
    this.acceptOwnResults(await applyTaskReport(this.input.cursor, payload));
  }

  /** Results the owner produced from its own task table, such as a timeout. */
  private acceptOwnResults(results: readonly RuntimeActionResult[]): void {
    if (results.length > 0) {
      this.runtimeResults.push({ kind: "runtime-action-result", results });
    }
  }

  /**
   * Sends each admitted delivery's answers to the tasks that asked, once. A
   * task blocked on an answer cannot wait for the turn to end, whoever gave
   * it; only a delivery that steers this turn may answer with its text or
   * dismiss a question.
   */
  private async routeAdmittedToChildren(): Promise<void> {
    for (const sequence of this.admitted) {
      if (this.routedToChildren.has(sequence)) continue;
      const delivery = this.input.queue.delivery(sequence);
      if (delivery === undefined) {
        this.admitted.delete(sequence);
        continue;
      }
      this.routedToChildren.add(sequence);
      const routed = await answerTaskInput(this.input.cursor, delivery, {
        steers: isSteeringDelivery(delivery, this.turn),
      });
      if (routed.kind === "cancel-turn") {
        this.input.queue.replaceDelivery(sequence, undefined);
        this.admitted.delete(sequence);
        this.abort("cancelled");
        return;
      }
      if (routed.dismissedCallIds !== undefined) {
        this.dismissedBy.set(sequence, routed.dismissedCallIds);
      }
      this.input.queue.replaceDelivery(sequence, routed.remainder);
      if (routed.remainder === undefined) this.admitted.delete(sequence);
    }
  }

  private abort(reason: StopReason): void {
    if (this.controller.signal.aborted) return;
    this.stopReason = reason;
    this.controller.abort(new TurnCancelledError());
  }
}

/** Why a turn stopped before it ended on its own. */
type StopReason = "cancelled" | "expired";

/**
 * The principal a turn acts for, as `turnStep` decides it: a result turn's
 * creator, else the auth of the delivery that starts it, else the session's
 * current principal. A person's answer to a request the session waits on
 * never changes its principal (see `readAnswerer`).
 */
function turnPrincipal(
  payload: TurnStepPayload | undefined,
  cursor: SessionStateCursor,
): SessionAuthContext | null {
  if (payload?.taskResults !== undefined) return readTaskCreator(payload.taskResults.creator).auth;
  const delivery = payload?.delivery;
  const { serializedContext } = cursor;
  const context = {
    has: (key: { readonly name: string }) => serializedContext[key.name] !== undefined,
  };
  const state = cursor.sessionState.snapshot.session.state;
  if (delivery?.auth !== undefined && readAnswerer(context, delivery, state) === undefined) {
    return delivery.auth;
  }
  return sessionPrincipal(serializedContext);
}

/** The principal the session acts for now: its last turn's. */
export function sessionPrincipal(
  serializedContext: Record<string, unknown>,
): SessionAuthContext | null {
  return (serializedContext[AuthKey.name] as SessionAuthContext | null | undefined) ?? null;
}
