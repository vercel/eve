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
import { isBetweenTurns, storedProjection } from "#harness/session-machine/view.js";
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
import {
  isAgentSessionMessage,
  type WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import type {
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { turnStep } from "#execution/session/turn-step.js";
import { exhaustedStepError, normalizeSerializableError } from "#execution/workflow-errors.js";
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

export function hasDelegatedCallerContext(serializedContext: Record<string, unknown>): boolean {
  if (earlierRemoteCaller(serializedContext) !== undefined) return false;
  if (serializedContext["eve.sessionCallback"] !== undefined) return true;
  const channel = serializedContext["eve.channel"];
  return (
    typeof channel === "object" && channel !== null && Reflect.get(channel, "kind") === "subagent"
  );
}

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

export class SessionExecution {
  private readonly input: SessionExecutionInput;
  private observedHandoverAttemptKey: string | undefined;

  constructor(input: SessionExecutionInput) {
    this.input = input;
  }

  get cursor(): SessionStateCursor {
    return this.input.cursor;
  }

  async runTurn(
    delivery: TurnStepPayload | undefined,
    options: {
      readonly caller?: TurnCaller;
      readonly control?: TurnControl;
    } = {},
  ): Promise<TurnOutcome> {
    const { cursor } = this.input;
    const starts = isBetweenTurns(storedProjection(cursor.sessionState.snapshot.session.state));
    const turn = new ActiveTurn(
      this.input,
      {
        caller: options.caller,
        control: delivery?.control !== undefined,
        principal: resolveTurnPrincipal(starts ? delivery : undefined, cursor.serializedContext),
      },
      options.control,
    );
    try {
      const outcome = await this.runTurnSteps(turn, delivery);
      await this.handleBoundaryMessages(turn.takeBoundaryMessages(), outcome.kind === "done");
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
      } else if (!ending || !isAgentSessionMessage(message)) {
        applied.push(message);
      }
    }
    await this.applyRunMessages(applied, turn);
  }

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
    let bindCaller = turn.caller;

    while (true) {
      const { cursor } = this.input;
      const caller = bindCaller;
      bindCaller = undefined;
      const observation = this.input.inbox.handoverObservation;
      const handover =
        observation?.attemptKey === this.observedHandoverAttemptKey ? undefined : observation;
      const result = await cursor.advanceWithHistory((state) => {
        const run = (recover?: { readonly error: unknown }) =>
          turnStep({
            ...state,
            handover,
            abortSignal: turn.signal,
            caller,
            input: nextStepInput,
            recover,
            steeringSignal: turn.steeringSignal,
          });
        return run().catch((error: unknown) =>
          run({ error: normalizeSerializableError(exhaustedStepError(error)) }),
        );
      });
      if (handover !== undefined) this.observedHandoverAttemptKey = handover.attemptKey;
      if (result.compacted === true) turn.compacted = true;

      const stepAdmission = this.input.queue.nextAdmission;
      const settles = result.action === "parked" && result.settled !== undefined;
      await turn.admitBoundary(settles);
      const ending = result.action === "done";
      await this.handleBoundaryMessages(
        turn.takeBoundaryMessages(),
        ending,
        ending ? undefined : turn,
      );

      if (result.action === "cancelled") return await this.finishCancelledTurn(turn);
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

  private async withSteering(
    turn: ActiveTurn,
    input: Omit<TurnStepPayload, "delivery">,
  ): Promise<TurnStepPayload | undefined> {
    const delivery = await turn.takeSteering();
    if (delivery === undefined && input.runtimeResults === undefined) return undefined;
    return { ...input, ...(delivery !== undefined && { delivery }) };
  }

  private async resume(
    turn: ActiveTurn,
    paused: TurnPause,
    heldSince: number,
  ): Promise<TurnStepPayload | undefined | "cancelled"> {
    const earlierCaller = earlierRemoteCaller(this.input.cursor.serializedContext);
    if (paused.on === "interaction" && earlierCaller !== undefined) {
      throw new Error(formatEarlierRemoteCallerInputError(earlierCaller));
    }
    if (
      paused.on === "interaction" &&
      paused.requestIds.length > 0 &&
      this.input.capabilities?.requestInput !== true &&
      !hasDelegatedCallerContext(this.input.cursor.serializedContext)
    ) {
      throw new Error(NO_INPUT_CAPABILITY_ERROR_MESSAGE);
    }
    const pendingInteraction =
      paused.on === "interaction"
        ? { attemptIds: new Set(paused.attemptIds), requestIds: new Set(paused.requestIds) }
        : undefined;
    const calls = paused.on === "calls" ? await this.startCallWait(paused) : undefined;
    let interrupted = false;
    while (true) {
      if (pendingInteraction !== undefined) {
        const callbacks = this.input.queue.takeAuthorizations(pendingInteraction.attemptIds);
        if (callbacks !== undefined) return { delivery: { kind: "deliver", payloads: callbacks } };
        const answer = await turn.takeAnswers(pendingInteraction.requestIds);
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

  private async startCallWait(
    paused: Extract<TurnPause, { readonly on: "calls" }>,
  ): Promise<CallWait> {
    const dispatched = paused.dispatch ? await this.dispatchRuns() : [];
    const wait = new CallWait(this.input.cursor, paused.callIds, dispatched);
    await wait.answerTaskToolCalls(paused.taskToolCalls);
    return wait;
  }

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
    const { executing, refused, started } = dispatched.pending;
    if (executing.length > 0 || started.length > 0 || refused.length > 0) {
      await cursor.advance((state) =>
        publishDispatchedCallsStep({ ...state, pending: dispatched.pending }),
      );
    }
    return dispatched.results;
  }

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

  async cancelTurnWork(): Promise<void> {
    await cancelWorkingTasks(this.input.cursor, "turn-cancelled", { turnCalls: true });
  }

  private async finishCancelledTurn(turn: ActiveTurn): Promise<TurnOutcome> {
    await this.handleBoundaryMessages(turn.takeBoundaryMessages(isAgentSessionMessage));
    await this.cancelTurnWork();
    const by = turn.cancelledBy;
    return by === undefined
      ? { cancelled: true, kind: "park" }
      : { cancelled: true, cancelledBy: controlDeliveryOf(by), kind: "park" };
  }
}

class CallWait {
  private readonly cursor: SessionStateCursor;
  private readonly callIds: readonly string[];
  private readonly results: RuntimeActionResult[] = [];
  private readonly acceptedAtMs = new Map<string, number>();
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

  timers(): readonly Promise<string>[] {
    return this.taskWaits.flatMap((wait) => (wait.timer === undefined ? [] : [wait.timer]));
  }

  timedOut(callId: string): void {
    for (const wait of this.taskWaits) {
      if (wait.callId === callId) wait.timedOut = true;
    }
  }

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

  acceptRun(result: RuntimeActionResult, message: WorkflowToolRunMessage): void {
    this.accept(result);
    if (message.kind === "outcome" && message.usage !== undefined) {
      this.delegatedUsage.set(result.callId, message.usage);
    }
  }

  async interrupt(): Promise<void> {
    const state = this.cursor.sessionState.snapshot.session.state;
    const runs = this.callIds.flatMap((callId) => {
      if (this.acceptedAtMs.has(callId)) return [];
      const run = findBlockingWorkflowToolRun(state, callId);
      return run === undefined ? [] : [run.address];
    });
    await Promise.all(runs.map((run) => interruptWorkflowToolRun(run)));
  }

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

interface TaskWait {
  readonly callId: string;
  readonly startedAtMs: number;
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
