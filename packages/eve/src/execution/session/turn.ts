import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { routeSelectedDelivery } from "#execution/session/route-selected-delivery.js";
import { isSteeringDelivery, type SessionInputQueue } from "#execution/session/input-queue.js";
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
import { coalesceDeliveries } from "#harness/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";
import {
  answerTaskInput,
  applyTaskDeadline,
  applyTaskOwnerUpdate,
  applyTaskReport,
  cancelTurnDescendants,
  endTaskWaits,
  interruptWaitedTasks,
  startPendingAgentTasks,
} from "#tasks/owner-body.js";
import { hasPendingTaskInput } from "#tasks/input.js";
import { flushUnsentCallerEvents } from "#subagents/remote/unsent-caller-events.js";
import {
  DISMISSED_CALL_GRACE_MS,
  resolveWaitInterruption,
  steeringInterruptsWait,
  type TaskWaitPlan,
  type WaitInterruption,
} from "#tasks/detach.js";
import type { TaskWaitRegistration } from "#tasks/wait.js";
import { WaitTimers } from "#tasks/wait-timers.js";
import { hasPendingBackgroundWork } from "#tasks/results.js";
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
   * the caller of the delivery that starts the turn.
   */
  async runTurn(
    delivery: TurnStepPayload | undefined,
    callerCallId: string | undefined = delivery?.delivery?.caller?.callId,
  ): Promise<TurnOutcome> {
    const turn = new ActiveTurn(this.input, callerCallId);
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

      if (result.action === "cancelled") return await this.finishCancelledTurn();
      if (!turnCompleted && turn.signal.aborted && pendingCallIds === undefined) {
        return await this.finishCancelledTurn();
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
          wait: dispatched.wait,
        });
        if (runtimeResults === "cancelled") return await this.finishCancelledTurn();
        // Steering accepted during the wait joins the same step as the results,
        // and receipts, of the calls it waited on.
        nextStepInput = { delivery: await turn.takeSteering(), runtimeResults };
        continue;
      }

      if (result.action === "park") {
        const canPark =
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && this.input.capabilities?.requestInput === true) ||
          this.input.mode === "conversation" ||
          // A task-mode run waits for its background tasks, then a result turn ends it.
          (result.settled !== undefined &&
            hasPendingBackgroundWork(cursor.sessionState.snapshot.session.state));
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

  private async finishCancelledTurn(): Promise<TurnOutcome> {
    const { cursor } = this.input;
    await endTaskWaits(cursor, { reason: "turn-cancelled" });
    await cancelTurnDescendants(cursor);
    return { cancelled: true, kind: "park" };
  }

  /**
   * Waits for every call in the batch. A `task_wait` ends at its timeout,
   * and a steering message ends every `task_wait` still waiting. In an
   * interactive root turn, a steering message also detaches the other calls
   * still waiting, except attached ones; in any session, it ends a waited
   * `sleep`. Each such call resolves at once with its own tool result.
   */
  private async waitForRuntimeActionResults(input: {
    readonly initialAcceptedAtMs: number | undefined;
    readonly initialResults: readonly RuntimeActionResult[];
    readonly pendingCallIds: readonly string[];
    readonly taskWaits: readonly TaskWaitRegistration[];
    readonly turn: ActiveTurn;
    readonly wait: TaskWaitPlan | undefined;
  }): Promise<RuntimeActionResultStepInput | "cancelled"> {
    const results: RuntimeActionResult[] = [...input.initialResults];
    const acceptedAtMsByCallId = new Map<string, number>();
    if (input.initialAcceptedAtMs !== undefined) {
      for (const result of results)
        acceptedAtMsByCallId.set(result.callId, input.initialAcceptedAtMs);
    }
    const unresolved = () =>
      input.pendingCallIds.filter((callId) => !results.some((result) => result.callId === callId));
    const { wait } = input;
    const waitCallIds = new Set(input.taskWaits.map(({ callId }) => callId));
    const steer = waitCallIds.size > 0 || (wait !== undefined && steeringInterruptsWait(wait));
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
    // Calls a steering message left waiting because it dismissed their
    // question, mapped to the call that names the message's detach group.
    const dismissed = new Map<string, string>();

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

      const next = await input.turn.nextRuntimeEvent({ steer, timer: timers.next() });
      if (next === "cancelled") return next;
      if (next.kind === "runtime-action-result") {
        accept(next.results);
        continue;
      }
      if (next.kind === "timeout") timers.disarm([next.callId]);
      // A timeout ends its own `task_wait`; a steering message ends every one
      // still waiting. The tasks keep working.
      const endedWaits = unresolved().filter(
        (callId) => waitCallIds.has(callId) && (next.kind === "steer" || callId === next.callId),
      );
      if (endedWaits.length > 0) {
        accept(
          await endTaskWaits(this.input.cursor, {
            callIds: endedWaits,
            reason: next.kind === "steer" ? "interrupted" : "timed_out",
          }),
        );
      }
      const changes =
        wait === undefined
          ? undefined
          : resolveWaitInterruption({
              dismissed,
              interruption: next,
              plan: wait,
              unresolvedCallIds: unresolved().filter((callId) => !waitCallIds.has(callId)),
            });
      if (changes === undefined) continue;
      accept(await interruptWaitedTasks(this.input.cursor, changes));
      // A dismissed call that keeps working past its grace period detaches
      // with the rest of the group, so the message never waits on it.
      const { groupCallId } = changes;
      if (changes.keepTaskIds.length === 0 || groupCallId === undefined) continue;
      for (const callId of changes.detachCallIds) {
        if (dismissed.has(callId) || !unresolved().includes(callId)) continue;
        dismissed.set(callId, groupCallId);
        timers.arm(callId, DISMISSED_CALL_GRACE_MS);
      }
    }
  }
}

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
 */
class ActiveTurn {
  private readonly admitted = new Set<number>();
  private readonly routedToChildren = new Set<number>();
  /** Tasks whose question each routed delivery dismissed, by admission sequence. */
  private readonly dismissedBy = new Map<number, readonly string[]>();
  /** Steering deliveries that already interrupted a runtime wait. */
  private readonly interruptedBy = new Set<number>();
  private readonly runtimeResults: RuntimeResultEvent[] = [];
  private readonly controller = new AbortController();
  private readonly expectedTurnId: string;
  private readonly input: SessionExecutionInput;
  private readonly callerCallId: string | undefined;
  private readonly unsubscribe: () => void;
  private unsubscribeDelivery: () => void;
  private steeringController = new AbortController();

  constructor(input: SessionExecutionInput, callerCallId: string | undefined) {
    this.input = input;
    this.callerCallId = callerCallId;
    this.expectedTurnId = activeTurnId(input.cursor.sessionState.emissionState);
    this.unsubscribe = input.inbox.onInterrupt((payload) => {
      if (this.cancelsThisTurn(payload)) this.abort();
    });
    this.unsubscribeDelivery = input.inbox.onDelivery(this.signalSteering);
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
      isSteeringDelivery(delivery, this.callerCallId) &&
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

  /** Steering admitted during this turn, routed to children first and coalesced. */
  async takeSteering(): Promise<DeliverHookPayload | undefined> {
    const steering: DeliverHookPayload[] = [];
    while (true) {
      const selection = this.input.queue.takeSteering(this.admitted, this.callerCallId);
      if (selection === undefined) break;
      for (const sequence of selection.sequences) this.admitted.delete(sequence);
      const routed = await routeSelectedDelivery(selection, this.input.cursor);
      if (routed.kind === "cancel-turn") {
        this.abort();
        break;
      }
      if (routed.kind === "turn") steering.push(routed.delivery);
    }
    if (steering.length === 0) return undefined;
    return steering.length === 1 ? steering[0] : coalesceDeliveries(steering);
  }

  /**
   * Next runtime result, admitting inbox traffic while waiting. With `steer`,
   * a steering message that remains after routing interrupts the wait once;
   * results the owner already produced come first. `timer` interrupts the
   * wait unless an inbox payload was accepted first.
   */
  async nextRuntimeEvent(
    options: { readonly steer?: boolean; readonly timer?: Promise<string> } = {},
  ): Promise<RuntimeEvent> {
    while (true) {
      if (this.signal.aborted) return "cancelled";
      const event = this.runtimeResults.shift();
      if (event !== undefined) return event;
      if (options.steer === true) {
        // Deliveries admitted at the step boundary may answer a question first.
        await this.routeAdmittedToChildren();
        if (this.signal.aborted) return "cancelled";
        const steering = this.takeWaitSteering();
        if (steering !== undefined) return steering;
      }
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
    const dismissedTaskIds: string[] = [];
    let steered = false;
    for (const sequence of this.admitted) {
      if (this.interruptedBy.has(sequence) || !this.routedToChildren.has(sequence)) continue;
      const delivery = this.input.queue.delivery(sequence);
      if (
        delivery === undefined ||
        !isSteeringDelivery(delivery, this.callerCallId) ||
        !delivery.payloads.some((payload) => payload.message !== undefined)
      ) {
        continue;
      }
      this.interruptedBy.add(sequence);
      dismissedTaskIds.push(...(this.dismissedBy.get(sequence) ?? []));
      steered = true;
    }
    return steered ? { dismissedTaskIds, kind: "steer" } : undefined;
  }

  private cancelsThisTurn(payload: SessionInboxPayload): boolean {
    if (payload.kind === "reset") return true;
    if (payload.kind !== "cancel") return false;
    return payload.turnId === undefined || payload.turnId === this.expectedTurnId;
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
        // Handled on admission, even between model steps: a background run's
        // outcome, question, or progress must not wait for a foreground wait.
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
      case "wait-results":
        this.acceptOwnResults(admitted.results);
        return;
      case "cancel":
        if (!this.cancelsThisTurn(value)) return;
        this.abort();
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

  /** During a runtime wait, descendant-bound answers cannot wait for the boundary. */
  private async routeAdmittedToChildren(): Promise<void> {
    for (const sequence of this.admitted) {
      if (this.routedToChildren.has(sequence)) continue;
      const delivery = this.input.queue.delivery(sequence);
      if (delivery === undefined) {
        this.admitted.delete(sequence);
        continue;
      }
      this.routedToChildren.add(sequence);
      const routed = await answerTaskInput(this.input.cursor, delivery);
      if (routed.kind === "cancel-turn") {
        this.input.queue.replaceDelivery(sequence, undefined);
        this.admitted.delete(sequence);
        this.abort();
        return;
      }
      if (routed.dismissedTaskIds !== undefined) {
        this.dismissedBy.set(sequence, routed.dismissedTaskIds);
      }
      this.input.queue.replaceDelivery(sequence, routed.remainder);
      if (routed.remainder === undefined) this.admitted.delete(sequence);
    }
  }

  private abort(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new TurnCancelledError());
  }
}
