import { EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { formatEarlierRemoteCallerInputError } from "#protocol/remote-agent-protocol.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import { sleep } from "#compiled/@workflow/core/index.js";

import type { SessionCapabilities, TurnCaller } from "#channel/types.js";
import {
  dispatchCoordinationStep,
  publishDispatchedCallsStep,
} from "#execution/coordination-dispatch-step.js";
import type { SessionInputQueue } from "#execution/session/input-queue.js";
import { taskToolResult, type TaskToolCall } from "#execution/tasks/calls.js";
import { TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import { resolveTurnPrincipal } from "#execution/session/principal.js";
import { renderTaskWaitResult } from "#execution/tasks/render.js";
import {
  answerTaskCancel,
  cancelWorkingTasks,
  sessionTaskTable,
} from "#execution/tasks/session.js";
import { taskWaitResult } from "#execution/tasks/table.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  handleWorkflowToolRunMessage,
  isAppliedRunMessage,
  takeLeadingAppliedRunMessages,
} from "#execution/session-workflow-tool-run.js";
import {
  applyRunMessagesStep,
  type AppliedRunMessage,
} from "#execution/tools/workflow/apply-run-messages-step.js";
import { interruptWorkflowToolRun } from "#execution/tools/workflow/interrupt.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import type {
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { turnStep } from "#execution/session/turn-step.js";
import { ActiveTurn } from "#execution/session/active-turn.js";
import type { TurnControl } from "#execution/session/turn-control.js";
import {
  findBlockingWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { startTaskToolCallsStep } from "#execution/session/task-tool-tracing-step.js";

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

const NO_INPUT_CAPABILITY_ERROR_MESSAGE =
  "This session cannot request human input, so it cannot wait for a tool approval or question. " +
  "Configure unattended tools with an approval policy that does not require human input.";

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
       * The delegated caller the turn answers, including for a first turn whose
       * input carries no caller. The turn's first step binds it into the context.
       */
      readonly caller?: TurnCaller;
      readonly control?: TurnControl;
    } = {},
  ): Promise<TurnOutcome> {
    let turn: ActiveTurn;
    try {
      turn = new ActiveTurn(
        this.input,
        {
          caller: options.caller,
          principal: resolveTurnPrincipal(delivery, this.input.cursor.serializedContext),
        },
        options.control,
      );
    } catch (error) {
      options.control?.dispose();
      throw error;
    }
    try {
      const outcome = await this.runTurnSteps(turn, delivery);
      // Tasks run beside the turn, and a run can open a session after its call
      // returns, so these messages still reach the session.
      await this.handleBoundaryMessages(turn.takeBoundaryMessages(), outcome.kind === "done");
      // The turn rule holds a turn while its tasks work, so a turn that ends
      // anyway, such as by failing, cancels them.
      if (outcome.kind === "park" && outcome.settled !== undefined) {
        await cancelWorkingTasks(this.input.cursor, "turn-ended");
      }
      return {
        ...outcome,
        ...(turn.caller !== undefined && { caller: turn.caller }),
        ...(turn.compacted && { compacted: true }),
      };
    } finally {
      turn.dispose();
    }
  }

  /**
   * Applies what runs reported while the model step ran, so the next step sees
   * it. Consecutive messages the session applies as it reads them, such as a
   * fan-out's, share one step. An ending session drops `agent-started`: its
   * stream is closed, and finalizing the session terminates the children.
   */
  private async handleBoundaryMessages(
    messages: readonly WorkflowToolRunMessage[],
    ending = false,
    turn?: ActiveTurn,
  ): Promise<void> {
    let applied: AppliedRunMessage[] = [];
    for (const message of messages) {
      if (!isAppliedRunMessage(message)) {
        await this.applyRunMessages(applied, turn);
        applied = [];
        await handleWorkflowToolRunMessage({ cursor: this.input.cursor, message });
      } else if (!ending || message.kind !== "agent-started") {
        applied.push(message);
      }
    }
    await this.applyRunMessages(applied, turn);
  }

  /** Hooks on the messages' events may cancel `turn`, the turn that is running. */
  private async applyRunMessages(
    messages: readonly AppliedRunMessage[],
    turn?: ActiveTurn,
  ): Promise<void> {
    if (messages.length === 0) return;
    const { cancelled } = await this.input.cursor.advance((state) =>
      applyRunMessagesStep({ ...state, canCancelTurn: turn !== undefined, messages }),
    );
    if (cancelled) turn?.abort();
  }

  private async runTurnSteps(
    turn: ActiveTurn,
    delivery: TurnStepPayload | undefined,
  ): Promise<TurnOutcome> {
    let nextStepInput: TurnStepPayload | undefined = delivery;
    // Only the first step binds the caller. A caller that steers in mid-turn is
    // replied to at its own address (`TurnOutcome.caller`) and is bound by the
    // next turn, so this turn's forwarding keeps its original caller.
    let bindCaller = turn.caller;

    while (true) {
      const { cursor } = this.input;
      const caller = bindCaller;
      bindCaller = undefined;
      const result = await cursor.advanceWithHistory((state) =>
        turnStep({
          ...state,
          abortSignal: turn.signal,
          caller,
          input: nextStepInput,
          steeringSignal: turn.steeringSignal,
        }),
      );
      if (result.compacted === true) turn.compacted = true;

      // Deliveries the boundary admits next arrived while the step ran. A step
      // that raises a request publishes it before it returns, so they may
      // reply to it.
      const stepAdmission = this.input.queue.nextAdmission;
      await turn.admitBoundary();
      const ending = result.action === "done";
      await this.handleBoundaryMessages(
        turn.takeBoundaryMessages(),
        ending,
        ending ? undefined : turn,
      );

      if (result.action === "cancelled") return await this.finishCancelledTurn(turn);
      // A settled turn stands, and calls the turn waits on still report, so neither cancels here.
      const settles = result.action === "parked" && result.settled !== undefined;
      const waitsOnCalls = result.action === "paused" && result.on === "calls";
      if (!settles && !waitsOnCalls && turn.signal.aborted) {
        return await this.finishCancelledTurn(turn);
      }

      switch (result.action) {
        case "done":
          return {
            isError: result.isError,
            kind: "done",
            output: result.output ?? "",
            usage: result.usage,
            usageDelta: result.usageDelta,
          };
        case "parked":
          return { kind: "park", settled: result.settled };
        case "paused": {
          const resumed = await this.resume(turn, result, stepAdmission);
          if (resumed === "cancelled") return await this.finishCancelledTurn(turn);
          nextStepInput = resumed;
          continue;
        }
        case "continue":
          nextStepInput = await this.withSteering(turn, {});
          continue;
      }
    }
  }

  /** The next step's input: what resumed the turn, behind any steering admitted meanwhile. */
  private async withSteering(
    turn: ActiveTurn,
    input: Omit<TurnStepPayload, "delivery">,
  ): Promise<TurnStepPayload | undefined> {
    const delivery = await turn.takeSteering();
    if (delivery === undefined && input.runtimeResults === undefined) return undefined;
    return { ...input, ...(delivery !== undefined && { delivery }) };
  }

  /**
   * Waits for what a paused turn awaits, and returns the input its next step reads:
   *
   * - a person's answer, a sign-in callback, or the turn's own person steering it, for the
   *   requests and sign-ins it raised. Anyone else's message queues behind the turn, as does a
   *   message admitted before the step that raised the request (`heldSince`): it was sent
   *   before the request existed;
   * - one of its tasks settling. Steering interrupts that wait;
   * - every call's result. Steering interrupts the workflow tool calls, which still report.
   */
  private async resume(
    turn: ActiveTurn,
    paused: TurnPause,
    heldSince: number,
  ): Promise<TurnStepPayload | undefined | "cancelled"> {
    const earlierCaller = earlierRemoteCaller(this.input.cursor.serializedContext);
    if (paused.on === "person" && earlierCaller !== undefined) {
      throw new Error(formatEarlierRemoteCallerInputError(earlierCaller));
    }
    if (
      paused.on === "person" &&
      paused.requestIds.length > 0 &&
      this.input.capabilities?.requestInput !== true &&
      !hasDelegatedCallerContext(this.input.cursor.serializedContext)
    ) {
      throw new Error(NO_INPUT_CAPABILITY_ERROR_MESSAGE);
    }
    const person =
      paused.on === "person"
        ? { attemptIds: new Set(paused.attemptIds), requestIds: new Set(paused.requestIds) }
        : undefined;
    const calls = paused.on === "calls" ? await this.startCallWait(paused) : undefined;
    let interrupted = false;
    while (true) {
      if (person !== undefined) {
        const callbacks = this.input.queue.takeAuthorizations(person.attemptIds);
        if (callbacks !== undefined) return { delivery: { kind: "deliver", payloads: callbacks } };
        const answer = await turn.takeAnswers(person.requestIds);
        if (answer !== undefined) return { delivery: answer };
        const steering = await turn.takeSteering({ heldSince });
        if (steering !== undefined) return { delivery: steering };
      }
      if (
        paused.on === "tasks" &&
        taskWaitResult(sessionTaskTable(this.input.cursor), { interrupted, timedOut: false }) !==
          undefined
      ) {
        return await this.withSteering(turn, {});
      }
      const runtimeResults = await calls?.ready(interrupted);
      if (runtimeResults !== undefined) return await this.withSteering(turn, { runtimeResults });

      const next = await turn.nextRuntimeEvent(calls?.timers() ?? []);
      if (next === "cancelled") return next;
      switch (next.kind) {
        case "steering":
          // Only the first steering message interrupts; later ones wait for the calls anyway.
          if (!interrupted) await calls?.interrupt();
          interrupted = true;
          continue;
        case "timeout":
          calls?.timedOut(next.callId);
          continue;
        case "runtime-action-result":
          calls?.acceptInbox(next.results);
          continue;
        case "workflow": {
          const result = await this.handleWorkflowMessage(next.message, turn);
          if (result !== undefined) calls?.acceptRun(result, next.message);
          continue;
        }
        case "input":
          continue;
      }
    }
  }

  /** Starts the runs a paused step asked for, answers its task tool calls, and tracks the rest. */
  private async startCallWait(
    paused: Extract<TurnPause, { readonly on: "calls" }>,
  ): Promise<CallWait> {
    const dispatched = paused.dispatch ? await this.dispatchRuns() : [];
    const wait = new CallWait(this.input.cursor, paused.callIds, dispatched);
    await wait.answerTaskToolCalls(paused.taskToolCalls);
    return wait;
  }

  /**
   * Starts the workflow tool runs a parked step requested, and returns the
   * results of any that settled at once. Task tool calls need no dispatch: the
   * session answers them itself.
   */
  private async dispatchRuns(): Promise<readonly RuntimeActionResult[]> {
    const { cursor } = this.input;
    const dispatched = await cursor.advance(({ serializedContext, sessionState }) =>
      dispatchCoordinationStep({
        serializedContext,
        sessionState,
        workflowToolRunOwner: {
          inbox: sessionInboxHookToken(sessionCommandHookToken(this.input.sessionId)),
        },
      }),
    );
    // Published in a step of its own, so a retry while it runs cannot start the runs again.
    const { executing, refused, started } = dispatched.pending;
    if (executing.length > 0 || started.length > 0 || refused.length > 0) {
      await cursor.advance((state) =>
        publishDispatchedCallsStep({ ...state, pending: dispatched.pending }),
      );
    }
    return dispatched.results;
  }

  /**
   * Handles a run message the session just read. One it applies as it reads
   * it takes along those read after it, from `turn` while a turn runs, so a
   * fan-out's messages share one step.
   */
  async handleWorkflowMessage(
    message: WorkflowToolRunMessage,
    turn?: ActiveTurn,
  ): Promise<RuntimeActionResult | undefined> {
    if (isAppliedRunMessage(message)) {
      const following =
        turn?.takeAppliedRunMessages() ?? takeLeadingAppliedRunMessages(this.input.inbox);
      await this.applyRunMessages([message, ...following], turn);
      return undefined;
    }
    return await handleWorkflowToolRunMessage({
      cursor: this.input.cursor,
      message,
    });
  }

  /**
   * Stops the work a cancelled turn leaves behind: the workflow tool runs it
   * waits on and every working task. A turn that waits on no run, the common
   * case, skips that durable step.
   */
  async cancelTurnWork(): Promise<void> {
    await cancelWorkingTasks(this.input.cursor, "turn-cancelled", { turnCalls: true });
  }

  /** `session.cancel()` stops the turn, the calls it waits on, and every working task. */
  private async finishCancelledTurn(turn: ActiveTurn): Promise<TurnOutcome> {
    // A child a run opened before the cancel appears before its task settles as cancelled.
    await this.handleBoundaryMessages(turn.takeBoundaryMessages("agent-started"));
    await this.cancelTurnWork();
    const by = turn.cancelledBy;
    return by === undefined
      ? { cancelled: true, kind: "park" }
      : { cancelled: true, cancelledBy: controlDeliveryOf(by), kind: "park" };
  }
}

/**
 * The calls a paused turn waits on: the results that arrived and when, what the `ctx.agent`
 * sessions behind them spent, and the `eve__task_wait` calls still parked.
 */
class CallWait {
  private readonly cursor: SessionStateCursor;
  private readonly callIds: readonly string[];
  private readonly results: RuntimeActionResult[] = [];
  private readonly acceptedAtMs = new Map<string, number>();
  /** By call id, so an outcome delivered twice counts once. */
  private readonly delegatedUsage = new Map<string, TokenUsage>();
  private taskWaits: TaskWait[] = [];

  constructor(
    cursor: SessionStateCursor,
    callIds: readonly string[],
    dispatched: readonly RuntimeActionResult[],
  ) {
    this.cursor = cursor;
    this.callIds = callIds;
    const acceptedAtMs = Date.now();
    for (const result of dispatched) this.accept(result, acceptedAtMs);
  }

  /** Every call's result, once each has one. */
  async ready(interrupted: boolean): Promise<RuntimeActionResultStepInput | undefined> {
    this.taskWaits = await this.resolveTaskWaits(interrupted);
    const ready = resolveRuntimeActionResultsForCallIds({
      pendingCallIds: this.callIds,
      results: this.results,
    });
    if (ready === undefined) return undefined;
    const delegatedUsage = ready.flatMap((result) => {
      const usage = this.delegatedUsage.get(result.callId);
      return usage === undefined ? [] : [[result.callId, usage] as const];
    });
    return {
      acceptedAtMsByCallId: Object.fromEntries(
        ready.map((result) => [result.callId, this.acceptedAtMs.get(result.callId)!]),
      ),
      ...(delegatedUsage.length > 0 && { delegatedUsage: Object.fromEntries(delegatedUsage) }),
      results: ready,
    };
  }

  /** The durable sleeps of the parked `eve__task_wait` calls. */
  timers(): readonly Promise<string>[] {
    return this.taskWaits.flatMap((wait) => (wait.timer === undefined ? [] : [wait.timer]));
  }

  timedOut(callId: string): void {
    for (const wait of this.taskWaits) {
      if (wait.callId === callId) wait.timedOut = true;
    }
  }

  /** Results through the turn inbox count only from runs the turn recorded. */
  acceptInbox(results: readonly RuntimeActionResult[]): void {
    const snapshot = this.cursor.sessionState.snapshot.session.state;
    const acceptedAtMs = Date.now();
    for (const result of results) {
      if (
        result.kind === "tool-result" &&
        isInboxToolResultFromRecordedWorkflowToolRun(snapshot, result)
      ) {
        this.accept(result, acceptedAtMs);
      }
    }
  }

  /** A run's message settled a call. */
  acceptRun(result: RuntimeActionResult, message: WorkflowToolRunMessage): void {
    this.accept(result);
    if (message.kind === "outcome" && message.usage !== undefined) {
      this.delegatedUsage.set(result.callId, message.usage);
    }
  }

  /** Aborts the `abortSignal` of every workflow tool call without a result yet. */
  async interrupt(): Promise<void> {
    const state = this.cursor.sessionState.snapshot.session.state;
    const runs = this.callIds.flatMap((callId) => {
      if (this.acceptedAtMs.has(callId)) return [];
      const run = findBlockingWorkflowToolRun(state, callId);
      return run === undefined ? [] : [run.address];
    });
    await Promise.all(runs.map((run) => interruptWorkflowToolRun(run)));
  }

  /**
   * `eve__task_cancel` is answered at once, and so is each `eve__task_wait` that can
   * return now: a timeout of 0, a result already waiting, or nothing working.
   * Any other `eve__task_wait` parks the open turn, reported once as
   * `turn.paused`, and the turn resolves it alongside the step's other
   * workflow tool calls.
   */
  async answerTaskToolCalls(calls: readonly TaskToolCall[]): Promise<void> {
    const waits: TaskWait[] = [];
    const startedAtMs = calls.length === 0 ? 0 : await startTaskToolCallsStep();
    for (const call of calls) {
      if (call.kind === TASK_WAIT_TOOL_NAME) {
        waits.push(startTaskWait(call, startedAtMs));
        continue;
      }
      this.accept(await answerTaskCancel(this.cursor, call));
    }
    this.taskWaits = waits;
    this.taskWaits = await this.resolveTaskWaits(false);
  }

  private accept(result: RuntimeActionResult, acceptedAtMs = Date.now()): void {
    this.results.push(result);
    this.acceptedAtMs.set(result.callId, acceptedAtMs);
  }

  /** Answers every `eve__task_wait` that can return now; returns the ones still waiting. */
  private async resolveTaskWaits(interrupted: boolean): Promise<TaskWait[]> {
    const table = sessionTaskTable(this.cursor);
    const waiting: TaskWait[] = [];
    for (const wait of this.taskWaits) {
      const result = taskWaitResult(table, { interrupted, timedOut: wait.timedOut });
      if (result === undefined) {
        waiting.push(wait);
        continue;
      }
      const text = renderTaskWaitResult(result, Date.now() - wait.startedAtMs);
      this.accept(taskToolResult(wait.callId, TASK_WAIT_TOOL_NAME, text));
    }
    return waiting;
  }
}

/**
 * One `eve__task_wait` call the turn is parked on. Its timeout is a durable sleep
 * the turn races against the inbox; nothing polls.
 */
interface TaskWait {
  readonly callId: string;
  readonly startedAtMs: number;
  /** Resolves with the call's id once the timeout passes; absent without a timeout. */
  readonly timer?: Promise<string>;
  timedOut: boolean;
}

function startTaskWait(
  call: Extract<TaskToolCall, { readonly kind: typeof TASK_WAIT_TOOL_NAME }>,
  startedAtMs: number,
): TaskWait {
  const { callId, timeoutMs } = call;
  const timer = timeoutMs === undefined ? undefined : sleep(timeoutMs).then(() => callId);
  return {
    callId,
    startedAtMs,
    timedOut: timeoutMs === 0,
    timer,
  };
}
