import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { routeSelectedDelivery } from "#execution/session/route-selected-delivery.js";
import { isSteeringDelivery, type SessionInputQueue } from "#execution/session/input-queue.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionInboxPayload, SessionInboxReader } from "#execution/session-inbox/inbox.js";
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
  applyTaskDeadline,
  applyTaskOwnerUpdate,
  applyTaskReport,
  cancelTurnDescendants,
  startPendingAgentTasks,
  syncTaskTimer,
} from "#tasks/owner-body.js";
import { hasPendingBackgroundWork } from "#tasks/results.js";
import { isWorkflowTaskResult } from "#tasks/state.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RunMode } from "#shared/run-mode.js";
import type { RuntimeActionResult, RuntimeSubagentChildResult } from "#shared/action-types.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";
const REMOTE_CALLER_WAIT_ERROR_MESSAGE =
  "This agent needs human input or authorization, but it was called by a remote agent that cannot answer. " +
  "Configure the tool or connection on this deployment so it does not require approval or sign-in.";

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

  async runTurn(delivery: TurnStepPayload | undefined): Promise<TurnOutcome> {
    const turn = new ActiveTurn(this.input, delivery?.delivery?.caller?.callId);
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
        const initialResults = [
          ...(await applyTaskOwnerUpdate(
            cursor,
            await dispatchCoordinationStep({
              action: result.action,
              callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
              workflowToolRunOwner: {
                inbox: sessionInboxHookToken(sessionCommandHookToken(this.input.sessionId)),
              },
              sessionWritable: cursor.sessionWritable,
              serializedContext: cursor.serializedContext,
              sessionState: cursor.sessionState,
            }),
          )),
          ...(await startPendingAgentTasks(cursor)),
        ];
        const initialAcceptedAtMs = initialResults.length === 0 ? undefined : Date.now();

        const runtimeResults = await this.waitForRuntimeActionResults({
          initialAcceptedAtMs,
          initialResults,
          pendingCallIds,
          turn,
        });
        if (runtimeResults === "cancelled") return await this.finishCancelledTurn();
        // Steering accepted during the wait is appended ahead of the result in
        // the same step, so the model sees it before the blocking action resolves.
        nextStepInput = { delivery: await turn.takeSteering(), runtimeResults };
        continue;
      }

      if (result.action === "park") {
        // A remote caller has no channel to answer on and waits on this child
        // without a deadline, so fail instead of parking the caller forever.
        if (
          delivery?.delivery?.caller?.replyTo.kind === "callback" &&
          (result.hasPendingAuthorization || result.hasPendingInputBatch)
        ) {
          throw new Error(REMOTE_CALLER_WAIT_ERROR_MESSAGE);
        }
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
    await cancelTurnDescendants(cursor);
    return { cancelled: true, kind: "park" };
  }

  private async waitForRuntimeActionResults(input: {
    readonly initialAcceptedAtMs: number | undefined;
    readonly initialResults: readonly RuntimeActionResult[];
    readonly pendingCallIds: readonly string[];
    readonly turn: ActiveTurn;
  }): Promise<RuntimeActionResultStepInput | "cancelled"> {
    const results: RuntimeActionResult[] = [...input.initialResults];
    const acceptedAtMsByCallId = new Map<string, number>();
    if (input.initialAcceptedAtMs !== undefined) {
      for (const result of results)
        acceptedAtMsByCallId.set(result.callId, input.initialAcceptedAtMs);
    }

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

      const next = await input.turn.nextRuntimeEvent();
      if (next === "cancelled") return next;
      const snapshot = this.input.cursor.sessionState.snapshot.session;
      const accepted = next.trusted
        ? next.results
        : next.results.filter(
            (result) => result.kind === "tool-result" && isWorkflowTaskResult(snapshot, result),
          );
      if (accepted.length > 0) {
        const acceptedAtMs = Date.now();
        results.push(...accepted);
        for (const result of accepted) acceptedAtMsByCallId.set(result.callId, acceptedAtMs);
      }
    }
  }
}

type RuntimeEvent =
  | {
      readonly kind: "runtime-action-result";
      readonly results: readonly RuntimeActionResult[];
      /** Produced by the owner's own task table rather than read from the inbox. */
      readonly trusted?: boolean;
    }
  | "cancelled";

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
  private readonly runtimeResults: RuntimeEvent[] = [];
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
      !this.input.cursor.sessionState.hasProxyInputRequests &&
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

  /** Next runtime result, admitting inbox traffic while waiting. */
  async nextRuntimeEvent(): Promise<RuntimeEvent> {
    while (true) {
      if (this.signal.aborted) return "cancelled";
      const event = this.runtimeResults.shift();
      if (event !== undefined) return event;
      const payload = await this.input.inbox.next();
      if (payload === undefined)
        throw new Error("Session inbox closed before runtime actions completed.");
      await this.admit(payload);
      await this.routeAdmittedToChildren();
    }
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
        const childResults = admitted.payload.results.filter(
          (result): result is RuntimeSubagentChildResult =>
            result.kind === "subagent-result" && result.origin === "child",
        );
        this.runtimeResults.push({
          kind: "runtime-action-result",
          results: admitted.payload.results.filter((result) => result.kind === "tool-result"),
        });
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
          this.runtimeResults.push({
            kind: "runtime-action-result",
            results: [result],
            trusted: true,
          });
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
      this.runtimeResults.push({ kind: "runtime-action-result", results, trusted: true });
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
      const routed = await routeDeliverToChildren({
        delivery,
        sessionWritable: this.input.cursor.sessionWritable,
        serializedContext: this.input.cursor.serializedContext,
        sessionState: this.input.cursor.sessionState,
      });
      await this.input.cursor.apply(routed);
      // An answered request can restart a task's deadline clock.
      await syncTaskTimer(this.input.cursor);
      if (routed.kind === "cancel-turn") {
        this.input.queue.replaceDelivery(sequence, undefined);
        this.admitted.delete(sequence);
        this.abort();
        return;
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
