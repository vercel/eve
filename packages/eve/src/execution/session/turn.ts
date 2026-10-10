import { EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { formatEarlierRemoteCallerInputError } from "#protocol/remote-agent-protocol.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";
import { sleep } from "#compiled/@workflow/core/index.js";

import type { SessionCapabilities, TurnCaller } from "#channel/types.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { SessionInputQueue } from "#execution/session/input-queue.js";
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
import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { publishTurnWaitingStep } from "#execution/session/turn-waiting-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  batchAgentStarts,
  handleWorkflowToolRunMessage,
} from "#execution/session-workflow-tool-run.js";
import { emitAgentStartedStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
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
import {
  startTaskToolCallsStep,
  traceTaskToolCallStep,
} from "#execution/session/task-tool-tracing-step.js";

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
        await cancelWorkingTasks(this.input.cursor, "turn_ended");
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

      await turn.admitBoundary();
      await this.handleBoundaryMessages(turn.takeBoundaryMessages(), result.action === "done");

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
          const resumed = await this.resume(turn, result);
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
   *   requests and sign-ins it raised. Anyone else's message queues behind the turn;
   * - one of its tasks settling. Steering interrupts that wait;
   * - every call's result. Steering interrupts the workflow tool calls, which still report.
   */
  private async resume(
    turn: ActiveTurn,
    paused: TurnPause,
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
    try {
      while (true) {
        if (person !== undefined) {
          const callbacks = this.input.queue.takeAuthorizations(person.attemptIds);
          if (callbacks !== undefined)
            return { delivery: { kind: "deliver", payloads: callbacks } };
          const answer = await turn.takeInputResponses(person.requestIds);
          if (answer !== undefined) return { delivery: answer };
          const steering = await turn.takeSteering({ heldOnPerson: true });
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
            const result = await this.handleWorkflowMessage(next.message);
            if (result !== undefined) calls?.acceptRun(result, next.message);
            continue;
          }
          case "input":
            continue;
        }
      }
    } finally {
      await calls?.dispose();
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
    const dispatched = await this.input.cursor.advance((state) =>
      dispatchCoordinationStep({
        workflowToolRunOwner: {
          inbox: sessionInboxHookToken(sessionCommandHookToken(this.input.sessionId)),
        },
        ...state,
      }),
    );
    return dispatched.results;
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

  /**
   * Stops the work a cancelled turn leaves behind: the workflow tool runs it
   * waits on and every working task. A turn that waits on no run, the common
   * case, skips that durable step.
   */
  async cancelTurnWork(): Promise<void> {
    await cancelWorkingTasks(this.input.cursor, "turn_cancelled", { turnCalls: true });
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

  /** Traces the `eve__task_wait` calls the turn stopped waiting on. */
  async dispose(): Promise<void> {
    for (const wait of this.taskWaits) await this.traceTaskWait(wait, undefined, true);
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
      const trace = (outcome: { readonly failed: true } | { readonly output: unknown }) =>
        this.cursor.advance((state) =>
          traceTaskToolCallStep(state, {
            callId: call.callId,
            toolName: call.kind,
            startedAtMs,
            completedAtMs: Date.now(),
            input: { taskId: call.taskId },
            ...outcome,
          }),
        );
      let result: RuntimeActionResult;
      try {
        result = await answerTaskCancel(this.cursor, call);
      } catch (error) {
        await trace({ failed: true });
        throw error;
      }
      await trace({ output: result.output });
      this.accept(result);
    }
    this.taskWaits = waits;
    this.taskWaits = await this.resolveTaskWaits(false);
    if (this.taskWaits.length > 0) await this.cursor.advance(publishTurnWaitingStep);
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
      await this.traceTaskWait(wait, text, interrupted);
      this.accept(taskToolResult(wait.callId, TASK_WAIT_TOOL_NAME, text));
    }
    return waiting;
  }

  private async traceTaskWait(wait: TaskWait, output?: string, failed = false): Promise<void> {
    await this.cursor.advance((state) =>
      traceTaskToolCallStep(state, {
        callId: wait.callId,
        toolName: TASK_WAIT_TOOL_NAME,
        startedAtMs: wait.startedAtMs,
        completedAtMs: Date.now(),
        input: wait.input,
        output,
        failed,
      }),
    );
  }
}

/**
 * One `eve__task_wait` call the turn is parked on. Its timeout is a durable sleep
 * the turn races against the inbox; nothing polls.
 */
interface TaskWait {
  readonly input: { readonly timeoutSeconds?: number };
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
    input: timeoutMs === undefined ? {} : { timeoutSeconds: timeoutMs / 1_000 },
    timedOut: timeoutMs === 0,
    timer,
  };
}
