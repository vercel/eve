import { EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME } from "#context/key-names.js";
import { formatEarlierRemoteCallerInputError } from "#protocol/remote-agent-protocol.js";
import { controlDeliveryOf } from "#execution/session/control-delivery.js";

import type { SessionCapabilities, TurnCaller } from "#channel/types.js";
import type {
  SessionStepCall,
  SessionStepName,
  SessionStepRunner,
} from "#execution/session/steps.js";
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
import type { AppliedRunMessage } from "#execution/tools/workflow/apply-run-messages.js";
import {
  isAgentSessionMessage,
  type WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import type { TurnPause } from "#execution/session/pending-turn-state.js";
import { openAfter } from "#execution/session/open-turn.js";
import type {
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepInput,
  TurnStepPayload,
} from "#execution/session/turn-step-types.js";
import { exhaustedStepError } from "#execution/workflow-errors.js";
import { isObject, readNonEmptyString } from "#shared/guards.js";
import { ActiveTurn } from "#execution/session/active-turn.js";
import type { TurnControl } from "#execution/session/turn-control.js";
import {
  findBlockingWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { PendingDispatch } from "#harness/session-machine/transitions.js";
import type { TokenUsage } from "#shared/token-usage.js";

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

export interface SessionTurnHost {
  readonly step: SessionStepCall;
  until(at: number): Promise<void>;
}

export interface SessionExecutionInput {
  readonly capabilities?: SessionCapabilities;
  readonly cursor: SessionStateCursor;
  readonly host: SessionTurnHost;
  readonly stepKey: (name: SessionStepName) => string;
  readonly inbox: SessionInboxReader;
  readonly queue: SessionInputQueue;
  readonly sessionId: string;
}

export class SessionExecution {
  private readonly input: SessionExecutionInput;
  private observedHandoverAttemptKey: string | undefined;
  private readonly outcomeMessages = new Map<string, WorkflowToolRunMessage>();

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
      readonly pause?: TurnPause;
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
      const outcome = await this.runTurnSteps(turn, delivery, options.pause);
      await this.handleBoundaryMessages(turn.takeBoundaryMessages(), outcome.kind === "done");
      if (outcome.kind === "park" && outcome.settled !== undefined) {
        await cancelWorkingTasks(this.input, this.input.cursor, "turn-ended");
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
        await this.input.cursor.consumed([message]);
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
    const { cancelled } = await this.input.cursor.advance(
      (state) =>
        this.input.host.step(
          "applyRunMessages",
          { ...state, canCancelTurn: turn !== undefined, messages },
          this.input.stepKey("applyRunMessages"),
        ),
      { consumes: messages },
    );
    if (cancelled) turn?.abort();
  }

  private async runTurnSteps(
    turn: ActiveTurn,
    delivery: TurnStepPayload | undefined,
    pause: TurnPause | undefined,
  ): Promise<TurnOutcome> {
    let nextStepInput: TurnStepPayload | undefined = delivery;
    if (pause !== undefined) {
      const resumed = await this.resume(turn, pause, this.input.queue.nextAdmission);
      if (resumed === "cancelled") return await this.finishCancelledTurn(turn);
      nextStepInput = resumed;
    }
    let bindCaller = turn.caller;

    while (true) {
      const { cursor } = this.input;
      const caller = bindCaller;
      bindCaller = undefined;
      const observation = this.input.inbox.handoverObservation;
      const handover =
        observation?.attemptKey === this.observedHandoverAttemptKey ? undefined : observation;
      const input = nextStepInput;
      const result = await cursor.advanceWithHistory(
        (state) => {
          const run = (recover?: TurnStepInput["recover"]) =>
            this.input.host.step(
              "turn",
              {
                ...state,
                handover,
                abortSignal: turn.signal,
                caller,
                input,
                recover,
                steeringSignal: turn.steeringSignal,
              },
              this.input.stepKey("turn"),
            );
          return run().catch((error: unknown) => {
            const thrown = exhaustedStepError(error);
            const name = isObject(thrown) ? readNonEmptyString(thrown.name) : undefined;
            return run({
              error: name === undefined ? {} : { name },
              ...(turn.signal.aborted && { stopped: true as const }),
            });
          });
        },
        {
          after: openAfter,
          before: { at: "step", ...(input !== undefined && { input }) },
          consumes: this.takeOutcomeMessages(input),
        },
      );
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
        case "workflow":
          await this.handleWorkflowMessage(next.message, turn, calls);
          continue;
        case "input":
          continue;
      }
    }
  }

  private async startCallWait(
    paused: Extract<TurnPause, { readonly on: "calls" }>,
  ): Promise<CallWait> {
    const dispatched = paused.dispatch
      ? await this.dispatchRuns(paused)
      : await this.resumeDispatched(paused);
    const wait = new CallWait(this.input, paused.callIds, dispatched);
    await wait.answerTaskToolCalls(paused.taskToolCalls);
    return wait;
  }

  private async dispatchRuns(
    paused: Extract<TurnPause, { readonly on: "calls" }>,
  ): Promise<readonly RuntimeActionResult[]> {
    const { cursor } = this.input;
    const dispatched = await cursor.advance(
      ({ serializedContext, sessionState }) =>
        this.input.host.step(
          "dispatchRuns",
          {
            serializedContext,
            sessionState,
            workflowToolRunOwner: {
              inbox: sessionInboxHookToken(sessionCommandHookToken(this.input.sessionId)),
            },
          },
          this.input.stepKey("dispatchRuns"),
        ),
      {
        after: (result) => ({
          at: "pause",
          pause: dispatchedPause(paused, result.results, result.pending),
        }),
      },
    );
    await this.publishDispatched(paused, dispatched.results, dispatched.pending);
    return dispatched.results;
  }

  private async resumeDispatched(
    paused: Extract<TurnPause, { readonly on: "calls" }>,
  ): Promise<readonly RuntimeActionResult[]> {
    const results = paused.results ?? [];
    if (paused.publish !== undefined) await this.publishDispatched(paused, results, paused.publish);
    return results;
  }

  private async publishDispatched(
    paused: Extract<TurnPause, { readonly on: "calls" }>,
    results: readonly RuntimeActionResult[],
    pending: PendingDispatch,
  ): Promise<void> {
    if (!hasPendingDispatch(pending)) return;
    await this.input.cursor.advance(
      (state) =>
        this.input.host.step(
          "publishDispatchedCalls",
          { ...state, pending },
          this.input.stepKey("publishDispatchedCalls"),
        ),
      { after: () => ({ at: "pause", pause: dispatchedPause(paused, results, undefined) }) },
    );
  }
  async handleWorkflowMessage(
    message: WorkflowToolRunMessage,
    turn?: ActiveTurn,
    calls?: CallWait,
  ): Promise<void> {
    if (isAppliedRunMessage(message)) {
      const following =
        turn?.takeAppliedRunMessages() ?? takeLeadingAppliedRunMessages(this.input.inbox);
      await this.applyRunMessages([message, ...following], turn);
      return;
    }
    const result = await handleWorkflowToolRunMessage({ cursor: this.input.cursor, message });
    if (result !== undefined && calls !== undefined) {
      calls.acceptRun(result, message);
      this.outcomeMessages.set(result.callId, message);
      return;
    }
    await this.input.cursor.consumed([message]);
  }

  private takeOutcomeMessages(input: TurnStepPayload | undefined): WorkflowToolRunMessage[] {
    return (input?.runtimeResults?.results ?? []).flatMap(({ callId }) => {
      const message = this.outcomeMessages.get(callId);
      this.outcomeMessages.delete(callId);
      return message === undefined ? [] : [message];
    });
  }

  async cancelTurnWork(): Promise<void> {
    await cancelWorkingTasks(this.input, this.input.cursor, "turn-cancelled", {
      turnCalls: true,
    });
  }

  private async finishCancelledTurn(turn: ActiveTurn): Promise<TurnOutcome> {
    await this.input.cursor.consumed([...this.outcomeMessages.values()]);
    this.outcomeMessages.clear();
    await this.handleBoundaryMessages(turn.takeBoundaryMessages(isAgentSessionMessage));
    await this.cancelTurnWork();
    const by = turn.cancelledBy;
    return by === undefined
      ? { cancelled: true, kind: "park" }
      : { cancelled: true, cancelledBy: controlDeliveryOf(by), kind: "park" };
  }
}

function hasPendingDispatch(pending: PendingDispatch): boolean {
  return pending.executing.length > 0 || pending.started.length > 0 || pending.refused.length > 0;
}

function dispatchedPause(
  paused: Extract<TurnPause, { readonly on: "calls" }>,
  results: readonly RuntimeActionResult[],
  pending: PendingDispatch | undefined,
): TurnPause {
  return {
    callIds: paused.callIds,
    dispatch: false,
    on: "calls",
    taskToolCalls: paused.taskToolCalls,
    ...(results.length > 0 && { results }),
    ...(pending !== undefined && hasPendingDispatch(pending) && { publish: pending }),
  };
}
class CallWait {
  private readonly cursor: SessionStateCursor;
  private readonly steps: SessionStepRunner;
  private readonly until: SessionTurnHost["until"];
  private readonly callIds: readonly string[];
  private readonly results: RuntimeActionResult[] = [];
  private readonly acceptedAtMs = new Map<string, number>();
  private readonly delegatedUsage = new Map<string, TokenUsage>();
  private taskWaits: TaskWait[] = [];

  constructor(
    session: Pick<SessionExecutionInput, "cursor" | "host" | "stepKey">,
    callIds: readonly string[],
    dispatched: readonly RuntimeActionResult[],
  ) {
    this.cursor = session.cursor;
    this.steps = { host: session.host, stepKey: session.stepKey };
    this.until = session.host.until;
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
    await Promise.all(
      runs.map((run) =>
        this.steps.host.step("interruptRun", run, this.steps.stepKey("interruptRun")),
      ),
    );
  }

  async answerTaskToolCalls(calls: readonly TaskToolCall[]): Promise<void> {
    const waits: TaskWait[] = [];
    const startedAtMs =
      calls.length === 0
        ? 0
        : await this.steps.host.step(
            "startTaskToolCalls",
            undefined,
            this.steps.stepKey("startTaskToolCalls"),
          );
    for (const call of calls) {
      if (call.kind === TASK_WAIT_TOOL_NAME) {
        waits.push(startTaskWait(call, startedAtMs, this.until));
        continue;
      }
      this.accept(await answerTaskCancel(this.steps, this.cursor, call));
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
  until: SessionTurnHost["until"],
): TaskWait {
  const { callId, timeoutMs } = call;
  const timer =
    timeoutMs === undefined ? undefined : until(startedAtMs + timeoutMs).then(() => callId);
  return {
    callId,
    startedAtMs,
    timedOut: timeoutMs === 0,
    timer,
  };
}
