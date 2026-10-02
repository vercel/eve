import { sleep } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities, TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
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
import type {
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { turnStep } from "#execution/session/turn-step.js";
import { ActiveTurn } from "#execution/session/active-turn.js";
import {
  findBlockingWorkflowToolRun,
  getBlockingWorkflowToolRuns,
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
       * The delegated caller the turn answers, including for a first turn whose
       * input carries no caller. The turn's first step binds it into the context.
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
        await cancelWorkingTasks(this.input.cursor, "turn_ended");
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

      if (result.action === "held" && result.hold === "request") {
        if (
          result.hasPendingInputBatch &&
          this.input.capabilities?.requestInput !== true &&
          !hasDelegatedCallerContext(this.input.cursor.serializedContext)
        ) {
          throw new Error(NO_INPUT_CAPABILITY_ERROR_MESSAGE);
        }
        const woke = await this.waitForHeldRequest(turn, result);
        if (woke === "cancelled") return await this.finishCancelledTurn(turn);
        nextStepInput = { delivery: woke };
        continue;
      }

      if (result.action === "held") {
        const woke = await this.waitForHeldTurn(turn);
        if (woke === "cancelled") return await this.finishCancelledTurn(turn);
        const steering = await turn.takeSteering();
        nextStepInput = steering === undefined ? undefined : { delivery: steering };
        continue;
      }

      if (pendingCallIds !== undefined && result.action === "park") {
        const dispatchResults = result.hasRunsToDispatch === false ? [] : await this.dispatchRuns();
        const initialAcceptedAtMs = dispatchResults.length === 0 ? undefined : Date.now();

        const runtimeResults = await this.waitForRuntimeActionResults({
          initialAcceptedAtMs,
          initialResults: dispatchResults,
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

      if (result.action === "park") return { kind: "park", settled: result.settled };

      const steering = await turn.takeSteering();
      nextStepInput = steering === undefined ? undefined : { delivery: steering };
    }
  }

  /**
   * Starts the workflow tool runs a parked step requested, and returns the
   * results of any that settled at once. Task tool calls need no dispatch: the
   * session answers them itself.
   */
  private async dispatchRuns(): Promise<readonly RuntimeActionResult[]> {
    const dispatched = await this.input.cursor.advance((state) =>
      dispatchCoordinationStep({
        action: "park",
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
    const { cursor } = this.input;
    if (mayWaitOnWorkflowToolRuns(cursor.sessionState)) {
      await cancelDescendantTurnsStep({ sessionState: cursor.sessionState });
    }
    await cancelWorkingTasks(cursor, "turn_cancelled");
  }

  /** `session.cancel()` stops the turn, the calls it waits on, and every working task. */
  private async finishCancelledTurn(turn: ActiveTurn): Promise<TurnOutcome> {
    // A child a run opened before the cancel appears before its task settles as cancelled.
    await this.handleBoundaryMessages(turn.takeBoundaryMessages("agent-started"));
    await this.cancelTurnWork();
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
        case "input":
        case "runtime-action-result":
        case "timeout":
          continue;
      }
    }
  }

  /**
   * The turn waits on a sign-in or tool approval it raised. It wakes with the
   * delivery its next step reads: the sign-in callback, an approval answer
   * from any responder, or a message from the turn's own person, which steers
   * the turn and cancels the request. Anyone else's message queues behind it.
   */
  private async waitForHeldRequest(
    turn: ActiveTurn,
    held: {
      readonly authorizationAttemptIds: readonly string[];
      readonly inputRequestIds: readonly string[];
    },
  ): Promise<DeliverHookPayload | "cancelled"> {
    const attemptIds = new Set(held.authorizationAttemptIds);
    const requestIds = new Set(held.inputRequestIds);
    while (true) {
      const callbacks = this.input.queue.takeAuthorizations(attemptIds);
      if (callbacks !== undefined) return { kind: "deliver", payloads: callbacks };
      const answer = await turn.takeInputResponses(requestIds);
      if (answer !== undefined) return answer;
      const steering = await turn.takeSteering({ heldOnPerson: true });
      if (steering !== undefined) return steering;
      const next = await turn.nextRuntimeEvent([]);
      if (next === "cancelled") return next;
      if (next.kind === "workflow") await this.handleWorkflowMessage(next.message);
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
      if (next.kind === "input") continue;
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

/** An unreadable run registry counts as waiting, so the step runs and logs it. */
function mayWaitOnWorkflowToolRuns(sessionState: DurableSessionState): boolean {
  try {
    return getBlockingWorkflowToolRuns(sessionState.snapshot?.session?.state).length > 0;
  } catch {
    return true;
  }
}
