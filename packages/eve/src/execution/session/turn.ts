import { sleep } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { routeSelectedDelivery } from "#execution/session/route-selected-delivery.js";
import {
  isSteeringMessage,
  type SessionInputQueue,
  type SteeringTurn,
} from "#execution/session/input-queue.js";
import { taskToolResult, type TaskToolCall } from "#execution/tasks/calls.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import { resolveTurnPrincipal } from "#execution/session/principal.js";
import { renderTaskWaitResult } from "#execution/tasks/render.js";
import {
  answerTaskCancel,
  cancelWorkingTasks,
  isTaskRunMessage,
  sessionTaskTable,
} from "#execution/tasks/session.js";
import { applyTaskRunMessageStep } from "#execution/tasks/steps.js";
import { taskWaitResult } from "#execution/tasks/table.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionInboxPayload, SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { publishTurnWaitingStep } from "#execution/session/turn-waiting-step.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  batchAgentStarts,
  handleWorkflowToolRunMessage,
} from "#execution/session-workflow-tool-run.js";
import { emitAgentStartedStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type {
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { turnStep } from "#execution/session/turn-step.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { decodeSessionInboxPayload } from "#execution/session-inbox/protocol.js";
import {
  findBlockingWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** True when a delegating parent (local or remote) receives this session's input requests. */
export function hasDelegatedCallerContext(serializedContext: Record<string, unknown>): boolean {
  if (serializedContext["eve.sessionCallback"] !== undefined) return true;
  const channel = serializedContext["eve.channel"];
  return (
    typeof channel === "object" && channel !== null && Reflect.get(channel, "kind") === "subagent"
  );
}

const NO_INPUT_CAPABILITY_ERROR_MESSAGE =
  "This session cannot request human input, so it cannot wait for a tool approval or question. " +
  "Sessions started without `capabilities.requestInput`, such as schedules, must not use approval-gated tools.";

export interface SessionExecutionInput {
  readonly capabilities?: SessionCapabilities;
  readonly cursor: SessionStateCursor;
  readonly inbox: SessionInboxReader;
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

  async runTurn(
    delivery: TurnStepPayload | undefined,
    options: {
      /**
       * The delegated caller the turn answers. The session binds it before the
       * turn, including for a first turn whose input carries no caller.
       */
      readonly caller?: TurnCaller;
    } = {},
  ): Promise<TurnOutcome> {
    const turn = new ActiveTurn(this.input, {
      caller: options.caller,
      principal: resolveTurnPrincipal(delivery, this.input.cursor.serializedContext),
    });
    try {
      const outcome = await this.runTurnSteps(turn, delivery);
      // Tasks run beside the turn, and a run can open a session after its call
      // returns, so these messages still reach the session.
      await this.handleBoundaryMessages(turn.takeBoundaryMessages(), outcome.kind === "done");
      // The turn rule holds a turn while its tasks work, so a turn that ends
      // anyway, such as by failing, cancels them.
      if (outcome.kind === "park" && outcome.settled !== undefined) {
        await cancelWorkingTasks(this.input.cursor);
      }
      return turn.caller === undefined ? outcome : { ...outcome, caller: turn.caller };
    } finally {
      turn.dispose();
    }
  }

  /**
   * Applies what runs reported while the model step ran, so the next step sees
   * it. Consecutive `agent-started` messages, such as a fan-out's, share one step.
   * An ending session drops them: its stream is closed, and finalizing the
   * session terminates the children.
   */
  private async handleBoundaryMessages(
    messages: readonly WorkflowToolRunMessage[],
    ending = false,
  ): Promise<void> {
    for (const batch of batchAgentStarts(messages)) {
      if (batch.kind === "message") {
        await this.handleWorkflowMessage(batch.message);
      } else if (!ending) {
        await this.input.cursor.advance((state) =>
          emitAgentStartedStep({ ...state, messages: batch.messages }),
        );
      }
    }
  }

  private async runTurnSteps(
    turn: ActiveTurn,
    delivery: TurnStepPayload | undefined,
  ): Promise<TurnOutcome> {
    let nextStepInput: TurnStepPayload | undefined = delivery;

    while (true) {
      const { cursor } = this.input;
      const result = await cursor.advance((state) =>
        turnStep({
          ...state,
          abortSignal: turn.signal,
          input: nextStepInput,
          steeringSignal: turn.steeringSignal,
        }),
      );
      const pendingCallIds =
        result.action === "park" ? result.pendingCoordinationCallIds : undefined;
      const turnCompleted = result.action === "park" && result.settled !== undefined;

      await turn.admitBoundary();
      await this.handleBoundaryMessages(turn.takeBoundaryMessages(), result.action === "done");

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

      if (result.action === "held") {
        const woke = await this.waitForHeldTurn(turn);
        if (woke === "cancelled") return await this.finishCancelledTurn(turn);
        const steering = await turn.takeSteering();
        nextStepInput = steering === undefined ? undefined : { delivery: steering };
        continue;
      }

      if (pendingCallIds !== undefined && result.action === "park") {
        const dispatchResult = await cursor.advance((state) =>
          dispatchCoordinationStep({
            action: result.action,
            workflowToolRunOwner: {
              inbox: sessionInboxHookToken(sessionCommandHookToken(this.input.sessionId)),
            },
            ...state,
          }),
        );
        const initialAcceptedAtMs = dispatchResult.results.length === 0 ? undefined : Date.now();

        const runtimeResults = await this.waitForRuntimeActionResults({
          initialAcceptedAtMs,
          initialResults: dispatchResult.results,
          taskToolCalls: result.pendingTaskToolCalls ?? [],
          pendingCallIds,
          turn,
        });
        if (runtimeResults === "cancelled") return await this.finishCancelledTurn(turn);
        // Steering accepted during the wait is appended ahead of the result in
        // the same step, so the model sees it before the blocking action resolves.
        nextStepInput = { delivery: await turn.takeSteering(), runtimeResults };
        continue;
      }

      if (result.action === "park") {
        if (
          result.hasPendingInputBatch &&
          this.input.capabilities?.requestInput !== true &&
          !hasDelegatedCallerContext(this.input.cursor.serializedContext)
        ) {
          throw new Error(NO_INPUT_CAPABILITY_ERROR_MESSAGE);
        }
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
    if (isTaskRunMessage(message)) {
      await this.input.cursor.advance((state) => applyTaskRunMessageStep({ ...state, message }));
      return undefined;
    }
    return await handleWorkflowToolRunMessage({
      cursor: this.input.cursor,
      message,
    });
  }

  /** `session.cancel()` stops the turn, the calls it waits on, and every working task. */
  private async finishCancelledTurn(turn: ActiveTurn): Promise<TurnOutcome> {
    const { cursor } = this.input;
    // A child a run opened before the cancel appears before its task settles as cancelled.
    await this.handleBoundaryMessages(turn.takeBoundaryMessages("agent-started"));
    await cancelDescendantTurnsStep({
      sessionState: cursor.sessionState,
    });
    await cancelWorkingTasks(cursor);
    return { cancelled: true, kind: "park" };
  }

  /**
   * The model tried to end the turn while its tasks work. The turn parks as
   * `task_wait` would, until one of them settles or the turn is steered.
   */
  private async waitForHeldTurn(turn: ActiveTurn): Promise<"cancelled" | "woke"> {
    let interrupted = false;
    while (true) {
      const wake = { interrupted, timedOut: false };
      if (taskWaitResult(sessionTaskTable(this.input.cursor), wake) !== undefined) {
        return "woke";
      }
      const next = await turn.nextRuntimeEvent([]);
      if (next === "cancelled") return next;
      switch (next.kind) {
        case "steering":
          interrupted = true;
          continue;
        case "workflow":
          await this.handleWorkflowMessage(next.message);
          continue;
        case "runtime-action-result":
        case "timeout":
          continue;
      }
    }
  }

  private async waitForRuntimeActionResults(input: {
    readonly initialAcceptedAtMs: number | undefined;
    readonly initialResults: readonly RuntimeActionResult[];
    readonly taskToolCalls: readonly TaskToolCall[];
    readonly pendingCallIds: readonly string[];
    readonly turn: ActiveTurn;
  }): Promise<RuntimeActionResultStepInput | "cancelled"> {
    const results: RuntimeActionResult[] = [...input.initialResults];
    let interrupted = false;
    const acceptedAtMsByCallId = new Map<string, number>();
    // By call id, so an outcome delivered twice counts once.
    const delegatedUsageByCallId = new Map<string, TokenUsage>();
    if (input.initialAcceptedAtMs !== undefined) {
      for (const result of results)
        acceptedAtMsByCallId.set(result.callId, input.initialAcceptedAtMs);
    }
    const accept = (result: RuntimeActionResult): void => {
      results.push(result);
      acceptedAtMsByCallId.set(result.callId, Date.now());
    };
    let taskWaits = await this.answerTaskToolCalls(input.taskToolCalls, accept);

    while (true) {
      taskWaits = this.resolveTaskWaits(taskWaits, interrupted, accept);
      const ready = resolveRuntimeActionResultsForCallIds({
        pendingCallIds: input.pendingCallIds,
        results,
      });
      if (ready !== undefined) {
        const delegatedUsage = ready.flatMap((result) => {
          const usage = delegatedUsageByCallId.get(result.callId);
          return usage === undefined ? [] : [usage];
        });
        return {
          acceptedAtMsByCallId: Object.fromEntries(
            ready.map((result) => [result.callId, acceptedAtMsByCallId.get(result.callId)!]),
          ),
          ...(delegatedUsage.length > 0 && { delegatedUsage }),
          results: ready,
        };
      }

      const timers = taskWaits.flatMap((wait) => (wait.timer === undefined ? [] : [wait.timer]));
      const next = await input.turn.nextRuntimeEvent(timers);
      if (next === "cancelled") return next;
      if (next.kind === "timeout") {
        for (const wait of taskWaits) {
          if (wait.callId === next.callId) wait.timedOut = true;
        }
        continue;
      }
      if (next.kind === "steering") {
        // Only the first steering message interrupts; later ones wait for the calls anyway.
        if (!interrupted) await this.interruptWaitedWorkflowCalls(input.pendingCallIds, results);
        interrupted = true;
        continue;
      }
      if (next.kind === "runtime-action-result") {
        const snapshot = this.input.cursor.sessionState.snapshot.session.state;
        const accepted = next.results.filter(
          (result) =>
            result.kind === "tool-result" &&
            isInboxToolResultFromRecordedWorkflowToolRun(snapshot, result),
        );
        if (accepted.length > 0) {
          const acceptedAtMs = Date.now();
          results.push(...accepted);
          for (const result of accepted) acceptedAtMsByCallId.set(result.callId, acceptedAtMs);
        }
        continue;
      }

      const result = await this.handleWorkflowMessage(next.message);
      if (result === undefined) continue;
      accept(result);
      if (next.message.kind === "outcome" && next.message.usage !== undefined) {
        delegatedUsageByCallId.set(result.callId, next.message.usage);
      }
    }
  }

  /** Answers every `task_wait` that can return now; returns the ones still waiting. */
  private resolveTaskWaits(
    waits: readonly TaskWait[],
    interrupted: boolean,
    accept: (result: RuntimeActionResult) => void,
  ): TaskWait[] {
    const table = sessionTaskTable(this.input.cursor);
    const waiting: TaskWait[] = [];
    for (const wait of waits) {
      const result = taskWaitResult(table, {
        interrupted,
        timedOut: wait.timedOut,
      });
      if (result === undefined) {
        waiting.push(wait);
        continue;
      }
      const text = renderTaskWaitResult(result, Date.now() - wait.startedAtMs);
      accept(taskToolResult(wait.callId, TASK_WAIT_TOOL_NAME, text));
    }
    return waiting;
  }

  /**
   * `task_cancel` is answered at once, and so is each `task_wait` that can
   * return now: a timeout of 0, a result already waiting, or nothing working.
   * Any other `task_wait` parks the open turn, reported once as
   * `turn.waiting`, and the turn resolves it alongside the step's other
   * deferred calls.
   */
  private async answerTaskToolCalls(
    calls: readonly TaskToolCall[],
    accept: (result: RuntimeActionResult) => void,
  ): Promise<TaskWait[]> {
    const waits: TaskWait[] = [];
    for (const call of calls) {
      if (call.kind === "task_wait") waits.push(startTaskWait(call));
      else accept(await answerTaskCancel(this.input.cursor, call));
    }
    const parked = this.resolveTaskWaits(waits, false, accept);
    if (parked.length > 0) await this.input.cursor.advance(publishTurnWaitingStep);
    return parked;
  }

  /** Aborts the `abortSignal` of every workflow tool call the wait has no result for yet. */
  private async interruptWaitedWorkflowCalls(
    pendingCallIds: readonly string[],
    settled: readonly RuntimeActionResult[],
  ): Promise<void> {
    const state = this.input.cursor.sessionState.snapshot.session.state;
    const settledCallIds = new Set(settled.map((result) => result.callId));
    const waited = pendingCallIds.filter((callId) => !settledCallIds.has(callId));
    const runs = waited.flatMap((callId) => {
      const run = findBlockingWorkflowToolRun(state, callId);
      return run === undefined ? [] : [run.address];
    });
    await Promise.all(runs.map((run) => interruptWorkflowToolRun(run)));
  }
}

/**
 * One `task_wait` call the turn is parked on. Its timeout is a durable sleep
 * the turn races against the inbox; nothing polls.
 */
interface TaskWait {
  readonly callId: string;
  readonly startedAtMs: number;
  /** Resolves with the call's id once the timeout passes; absent without a timeout. */
  readonly timer?: Promise<string>;
  timedOut: boolean;
}

function startTaskWait(call: Extract<TaskToolCall, { readonly kind: "task_wait" }>): TaskWait {
  const { callId, timeoutMs } = call;
  const timer = timeoutMs === undefined ? undefined : sleep(timeoutMs).then(() => callId);
  return { callId, startedAtMs: Date.now(), timedOut: false, timer };
}

type RuntimeEvent =
  | { readonly kind: "runtime-action-result"; readonly results: readonly RuntimeActionResult[] }
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  /** A steering message that answered no pending request arrived during the wait. */
  | { readonly kind: "steering" }
  /** A `task_wait` call's timeout passed. */
  | { readonly kind: "timeout"; readonly callId: string }
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
  /** Who alone steers the turn: its principal, or its delegated caller. */
  private readonly identity: SteeringTurn;
  private readonly unsubscribe: () => void;
  private unsubscribeDelivery: () => void;
  private steeringController = new AbortController();
  /** The delegated caller of the latest message the turn read. */
  caller: TurnCaller | undefined;

  constructor(
    input: SessionExecutionInput,
    owner: { readonly caller: TurnCaller | undefined; readonly principal: string },
  ) {
    this.input = input;
    this.caller = owner.caller;
    this.identity = { callerCallId: owner.caller?.callId, principal: owner.principal };
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
      isSteeringMessage(delivery, this.identity) &&
      !this.input.cursor.sessionState.hasProxyInputRequests
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

  private resetSteering(): void {
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
   * Steering admitted during this turn, routed to children first and coalesced.
   * The next step reads it as input, so its signal must not interrupt that
   * step; only deliveries still unread re-signal the next generation.
   */
  async takeSteering(): Promise<DeliverHookPayload | undefined> {
    const steering: DeliverHookPayload[] = [];
    while (true) {
      const selection = this.input.queue.takeSteering(this.admitted, this.identity);
      if (selection === undefined) break;
      for (const sequence of selection.sequences) this.admitted.delete(sequence);
      const routed = await routeSelectedDelivery(selection, this.input.cursor);
      if (routed.kind === "cancel-turn") {
        this.abort();
        break;
      }
      if (routed.kind === "turn") steering.push(routed.delivery);
    }
    this.resetSteering();
    if (steering.length === 0) return undefined;
    const delivery = steering.length === 1 ? steering[0]! : coalesceDeliveries(steering);
    if (delivery.caller !== undefined) this.caller = delivery.caller;
    return delivery;
  }

  /**
   * Removes the admitted run messages the session applies at once instead of
   * in a runtime wait, or only those of `kind`.
   */
  takeBoundaryMessages(kind?: "agent-started"): WorkflowToolRunMessage[] {
    const taken: WorkflowToolRunMessage[] = [];
    const kept: RuntimeEvent[] = [];
    for (const event of this.runtimeResults) {
      const message = asBoundaryMessage(event);
      if (message === undefined || (kind !== undefined && message.kind !== kind)) kept.push(event);
      else taken.push(message);
    }
    this.runtimeResults.splice(0, this.runtimeResults.length, ...kept);
    return taken;
  }

  /**
   * Next runtime result, workflow message, steering, or timeout, admitting
   * inbox traffic while waiting. Deliveries admitted before the wait began are
   * routed first, so a message that arrived as the calls started still steers.
   * `timers` are durable sleeps raced against the inbox.
   */
  async nextRuntimeEvent(timers: readonly Promise<string>[]): Promise<RuntimeEvent> {
    while (true) {
      const steered = await this.routeAdmittedToChildren();
      if (this.signal.aborted) return "cancelled";
      if (steered) return { kind: "steering" };
      const event = this.runtimeResults.shift();
      if (event !== undefined) return event;
      const elapsed = await this.waitForInboxOrTimer(timers);
      if (elapsed !== undefined) return { callId: elapsed, kind: "timeout" };
      const payload = await this.input.inbox.next();
      if (payload === undefined)
        throw new Error("Session inbox closed before runtime actions completed.");
      await this.admit(payload);
    }
  }

  /** Resolves with the id of the call whose timer won, or `undefined` once inbox input is ready. */
  private async waitForInboxOrTimer(
    timers: readonly Promise<string>[],
  ): Promise<string | undefined> {
    if (timers.length === 0 || this.input.inbox.hasPending()) return undefined;
    const inboxReady = this.input.inbox.whenPending().then(() => undefined);
    return await Promise.race([inboxReady, ...timers]);
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
      case "runtime-action-result":
        this.runtimeResults.push({
          kind: "runtime-action-result",
          results: admitted.payload.results,
        });
        return;
      case "workflow":
        this.runtimeResults.push({ kind: "workflow", message: admitted.message });
        return;
      case "cancel":
        if (this.cancelsThisTurn(value)) this.abort();
        return;
      case "consumed":
        return;
    }
  }

  /**
   * During a runtime wait, descendant-bound answers cannot wait for the
   * boundary. Returns whether a newly routed delivery still steers: it
   * answered nothing, so its message is for the model.
   */
  private async routeAdmittedToChildren(): Promise<boolean> {
    let steered = false;
    for (const sequence of this.admitted) {
      if (this.routedToChildren.has(sequence)) continue;
      const delivery = this.input.queue.delivery(sequence);
      if (delivery === undefined) {
        this.admitted.delete(sequence);
        continue;
      }
      this.routedToChildren.add(sequence);
      const routed = await this.input.cursor.advance((state) =>
        routeDeliverToChildren({ delivery, ...state }),
      );
      if (routed.kind === "cancel-turn") {
        this.input.queue.replaceDelivery(sequence, undefined);
        this.admitted.delete(sequence);
        this.abort();
        return false;
      }
      this.input.queue.replaceDelivery(sequence, routed.remainder);
      if (routed.remainder === undefined) {
        this.admitted.delete(sequence);
        continue;
      }
      if (isSteeringMessage(routed.remainder, this.identity)) steered = true;
    }
    return steered;
  }

  private abort(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new TurnCancelledError());
  }
}

function asBoundaryMessage(event: RuntimeEvent): WorkflowToolRunMessage | undefined {
  if (event === "cancelled" || event.kind !== "workflow") return undefined;
  // Tasks run beside the turn, so everything their runs send, such as a
  // question, reaches the session at the next boundary rather than at turn end.
  if (event.message.from.taskId !== undefined) return event.message;
  // An `execute` run can open a session after its call returns, when the turn
  // may have no wait left to take the message, and publishing it needs none.
  if (event.message.kind === "agent-started") return event.message;
  return undefined;
}
