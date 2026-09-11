import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { reportDroppedWirePayloadStep } from "#execution/report-dropped-wire-payload-step.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionCommandInbox, SessionInboxPayload } from "#execution/session-command-inbox.js";
import { SessionExecutionCursor } from "#execution/session-execution-cursor.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import {
  openWorkflowToolRunOwnerInbox,
  type WorkflowToolRunOwnerInbox,
} from "#execution/tools/workflow/owner.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import type {
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/turn-step.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { turnStep } from "#execution/workflow-steps.js";
import {
  decodeSessionInboxPayload,
  SessionInboxPayloadError,
} from "#execution/wire/session-inbox-wire.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import {
  isInboxSubagentResultFromRecordedWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import {
  findRunningAgentHandle,
  isInboxSubagentResultFromRunningHandle,
} from "#subagents/handles/query.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RunMode } from "#shared/run-mode.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

interface TurnCancelPayload {
  readonly tasks?: boolean;
  readonly turnId?: string;
}

/** Inputs shared by every turn executed inside the owning session workflow. */
export interface SessionExecutionInput {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly cancelledTaskIds: Set<string>;
  readonly capabilities?: SessionCapabilities;
  readonly commandInbox: SessionCommandInbox;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly seenTaskDeliveries: Set<string>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly stateCursor?: SessionExecutionCursor;
}

/**
 * Executes all conversational work in the session owner. There is no child
 * turn run or private transport protocol: commands, cancellation, coordination, and
 * state adoption meet at this one boundary.
 */
export class SessionExecution {
  readonly cursor: SessionExecutionCursor;

  private readonly input: SessionExecutionInput;
  private readonly workflowInbox: WorkflowToolRunOwnerInbox;
  private pendingWorkflowRead:
    | Promise<
        IteratorResult<import("#execution/tools/workflow/messages.js").WorkflowToolRunMessage>
      >
    | undefined;

  constructor(input: SessionExecutionInput) {
    this.input = input;
    this.cursor =
      input.stateCursor ??
      new SessionExecutionCursor({
        commandInbox: input.commandInbox,
        parentWritable: input.parentWritable,
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      });
    this.workflowInbox = openWorkflowToolRunOwnerInbox();
  }

  async dispose(): Promise<void> {
    await this.workflowInbox.dispose();
  }

  async runTurn(delivery: TurnStepPayload): Promise<TurnOutcome> {
    const control = new ActiveTurnControl({
      bufferedDeliveries: this.input.bufferedDeliveries,
      bufferedSessionControls: this.input.bufferedSessionControls,
      cancelledTaskIds: this.input.cancelledTaskIds,
      commandInbox: this.input.commandInbox,
      cursor: this.cursor,
      expectedTurnId: activeTurnId(this.cursor.sessionState.emissionState),
      seenTaskDeliveries: this.input.seenTaskDeliveries,
    });
    let nextStepInput: TurnStepPayload | undefined = delivery;

    while (true) {
      const beforeStep = {
        serializedContext: this.cursor.serializedContext,
        sessionState: this.cursor.sessionState,
      };
      const result = await control.waitFor(
        turnStep(this.cursor.createStepInput(nextStepInput, control.signal)),
      );
      const pendingCallIds =
        result.action === "dispatch-workflow-tasks"
          ? result.pendingTaskCallIds
          : result.action === "park"
            ? result.pendingCoordinationCallIds
            : undefined;
      const hasBackgroundTasks = (result.backgroundTasks?.length ?? 0) > 0;

      if (hasBackgroundTasks) {
        if (result.backgroundTaskState === undefined) {
          throw new Error("Background tasks were returned without their committed session state.");
        }
        await this.cursor.adopt({
          serializedContext: beforeStep.serializedContext,
          sessionState: result.backgroundTaskState,
        });
        await acknowledgeDelegatedTasksStep({ tasks: result.backgroundTasks ?? [] });
      }

      if (result.action === "cancelled") {
        await this.cursor.adopt({
          serializedContext: result.serializedContext,
          sessionState: result.backgroundTaskState ?? result.sessionState,
        });
        return await this.finishCancelledTurn(control);
      }

      if (control.signal.aborted && (pendingCallIds === undefined || hasBackgroundTasks)) {
        await this.cursor.adopt({
          serializedContext: result.serializedContext,
          sessionState: result.backgroundTaskState ?? result.sessionState,
        });
        return await this.finishCancelledTurn(control);
      }

      if (result.action === "done") {
        await this.cursor.adopt(result);
        return this.outcome({
          isError: result.isError,
          kind: "done",
          output: result.output ?? "",
          usage: result.usage,
          usageDelta: result.usageDelta,
        });
      }

      if (
        pendingCallIds !== undefined &&
        (result.action === "park" || result.action === "dispatch-workflow-tasks")
      ) {
        await this.cursor.adopt(result);
        const dispatchResult = await dispatchCoordinationStep({
          action: result.action,
          callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
          workflowToolRunOwner: this.workflowInbox.owner,
          parentWritable: this.cursor.parentWritable,
          serializedContext: this.cursor.serializedContext,
          sessionState: this.cursor.sessionState,
        });
        const initialAcceptedAtMs = dispatchResult.results.length === 0 ? undefined : Date.now();
        await this.cursor.adopt(dispatchResult);
        await acknowledgeDelegatedTasksStep({ tasks: dispatchResult.pendingTasks });

        const results = await this.waitForRuntimeActionResults({
          control,
          initialAcceptedAtMs,
          initialResults: dispatchResult.results,
          pendingCallIds,
        });
        if (results === "cancel-turn") return await this.finishCancelledTurn(control);
        if (results === "cancelled") {
          nextStepInput = undefined;
          continue;
        }
        nextStepInput = results;
        continue;
      }

      if (result.action === "park") {
        const canPark =
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && this.input.capabilities?.requestInput === true) ||
          this.input.mode === "conversation";
        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);
        await this.cursor.adopt(result);
        return this.outcome({
          authorizationAttemptIds: result.authorizationAttemptIds,
          authorizationNames: result.authorizationNames,
          kind: "park",
          settled: result.settled,
        });
      }

      await this.cursor.adopt(result);
      nextStepInput = undefined;
    }
  }

  private async finishCancelledTurn(control: ActiveTurnControl): Promise<TurnOutcome> {
    if (control.cancellation?.tasks === true) {
      await cancelAllIndexedSessionTasksStep({
        serializedContext: this.cursor.serializedContext,
        sessionState: this.cursor.sessionState,
      });
    }
    await cancelDescendantTurnsStep({
      serializedContext: this.cursor.serializedContext,
      sessionState: this.cursor.sessionState,
    });
    return this.outcome({ cancelled: true, kind: "park" });
  }

  private outcome<T extends Omit<TurnOutcome, "serializedContext" | "sessionState">>(
    value: T,
  ): TurnOutcome {
    return {
      ...value,
      serializedContext: this.cursor.serializedContext,
      sessionState: this.cursor.sessionState,
    } as TurnOutcome;
  }

  private async waitForRuntimeActionResults(input: {
    readonly control: ActiveTurnControl;
    readonly initialAcceptedAtMs: number | undefined;
    readonly initialResults: readonly RuntimeActionResult[];
    readonly pendingCallIds: readonly string[];
  }): Promise<RuntimeActionResultStepInput | "cancelled" | "cancel-turn"> {
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
          kind: "runtime-action-result",
          results: ready,
        };
      }

      const next = await this.nextRuntimeEvent(input.control);
      if (next === "cancelled" || next === "cancel-turn") return next;
      if (next.kind === "runtime-action-result") {
        const snapshot = this.cursor.sessionState.snapshot?.session.state;
        const accepted = next.results.filter((result) => {
          if (result.kind === "tool-result") {
            return isInboxToolResultFromRecordedWorkflowToolRun(snapshot, result);
          }
          if (result.kind !== "subagent-result") return false;
          return (
            (result.origin === "child" &&
              isInboxSubagentResultFromRunningHandle(snapshot, result)) ||
            isInboxSubagentResultFromRecordedWorkflowToolRun(snapshot, result)
          );
        });
        if (accepted.length > 0) {
          const acceptedAtMs = Date.now();
          results.push(...accepted);
          for (const result of accepted) acceptedAtMsByCallId.set(result.callId, acceptedAtMs);
        }
        continue;
      }

      const result = await handleWorkflowToolRunMessage({
        callbackMetadataUrl: getWorkflowMetadata().url,
        cursor: this.cursor,
        message: next.message,
      });
      if (result !== undefined) {
        results.push(result);
        acceptedAtMsByCallId.set(result.callId, Date.now());
      }
    }
  }

  private async nextRuntimeEvent(control: ActiveTurnControl): Promise<
    | RuntimeActionResultStepInput
    | {
        readonly kind: "workflow";
        readonly message: import("#execution/tools/workflow/messages.js").WorkflowToolRunMessage;
      }
    | "cancelled"
    | "cancel-turn"
  > {
    while (true) {
      const winner = await Promise.race([
        this.workflowRead().then((result) => ({ kind: "workflow" as const, result })),
        this.input.commandInbox.next().then((result) => ({ kind: "command" as const, result })),
      ]);

      if (winner.kind === "workflow") {
        this.pendingWorkflowRead = undefined;
        if (winner.result.done) {
          throw new Error("Workflow tool inbox closed before runtime actions completed.");
        }
        return { kind: "workflow", message: winner.result.value };
      }

      if (winner.result.done) {
        throw new Error("Session command inbox closed before runtime actions completed.");
      }
      this.input.commandInbox.consumeNext();
      const value = winner.result.value;
      if (value.kind === "runtime-action-result") {
        return { kind: "runtime-action-result", results: value.results };
      }
      const command = await control.handle(value, true);
      if (command === "cancel-turn") return command;
      if (control.signal.aborted) return "cancelled";
    }
  }

  private workflowRead() {
    this.pendingWorkflowRead ??= this.workflowInbox.reader.iterator.next();
    return this.pendingWorkflowRead;
  }
}

class ActiveTurnControl {
  private readonly bufferedDeliveries: DeliverHookPayload[];
  private readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  private readonly cancelledTaskIds: Set<string>;
  private readonly commandInbox: SessionCommandInbox;
  private readonly controller = new AbortController();
  private readonly cursor: SessionExecutionCursor;
  private readonly expectedTurnId: string;
  private readonly seenTaskDeliveries: Set<string>;
  private currentCancellation: TurnCancelPayload | undefined;

  constructor(input: {
    readonly bufferedDeliveries: DeliverHookPayload[];
    readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
    readonly cancelledTaskIds: Set<string>;
    readonly commandInbox: SessionCommandInbox;
    readonly cursor: SessionExecutionCursor;
    readonly expectedTurnId: string;
    readonly seenTaskDeliveries: Set<string>;
  }) {
    this.bufferedDeliveries = input.bufferedDeliveries;
    this.bufferedSessionControls = input.bufferedSessionControls;
    this.cancelledTaskIds = input.cancelledTaskIds;
    this.commandInbox = input.commandInbox;
    this.cursor = input.cursor;
    this.expectedTurnId = input.expectedTurnId;
    this.seenTaskDeliveries = input.seenTaskDeliveries;
  }

  get cancellation(): TurnCancelPayload | undefined {
    return this.currentCancellation;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then((value) => ({ kind: "operation" as const, value }));
    while (true) {
      const winner = await Promise.race([
        settled,
        this.commandInbox.next().then((result) => ({ kind: "command" as const, result })),
      ]);
      if (winner.kind === "operation") return winner.value;
      if (winner.result.done) {
        throw new Error("Session command inbox closed before the active turn settled.");
      }
      this.commandInbox.consumeNext();
      await this.handle(winner.result.value, false);
    }
  }

  async handle(
    value: SessionInboxPayload,
    routeDeliveries: boolean,
  ): Promise<"cancel-turn" | void> {
    if (value.kind === "runtime-action-result") return;
    if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
      const handle = findRunningAgentHandle(this.cursor.sessionState.snapshot?.session.state, {
        callId: value.callId,
      });
      if (
        handle?.identity.name !== value.subagentName ||
        handle.address.sessionId !== value.childSessionId
      ) {
        return;
      }
      await this.cursor.adopt(
        await runProxySubagentEventStep({
          hookPayload: value,
          parentWritable: this.cursor.parentWritable,
          serializedContext: this.cursor.serializedContext,
          sessionState: this.cursor.sessionState,
        }),
      );
      return;
    }
    let command;
    try {
      command = decodeSessionInboxPayload(value);
    } catch (error) {
      if (!(error instanceof SessionInboxPayloadError)) throw error;
      await reportDroppedWirePayloadStep({ detail: error.message, family: "session-inbox" });
      return;
    }

    if (command.kind === "deliver") {
      if (!this.acceptTaskDelivery(command)) return;
      let delivery: DeliverHookPayload | undefined = command;
      if (routeDeliveries) {
        const routed = await routeDeliverToChildren({
          delivery,
          parentWritable: this.cursor.parentWritable,
          serializedContext: this.cursor.serializedContext,
          sessionState: this.cursor.sessionState,
        });
        await this.cursor.adopt(routed);
        if (routed.kind === "cancel-turn") {
          this.abort({});
          return "cancel-turn";
        }
        delivery = routed.remainder;
      }
      if (delivery === undefined) return;
      this.bufferedDeliveries.push(delivery);
      if (delivery.turnPolicy === "steer" && deliveryHasMessage(delivery)) this.abort({});
      return;
    }
    if (command.kind === "clear" || command.kind === "compact") {
      this.bufferedSessionControls.push(command.kind);
      return;
    }
    if (command.kind === "session-timeout") {
      this.bufferedSessionControls.push("expired");
      return;
    }
    if (command.kind === "reset") {
      this.bufferedSessionControls.push("reset");
      this.abort({});
      return;
    }

    if (command.tasks === true) {
      await cancelAllIndexedSessionTasksStep({
        serializedContext: this.cursor.serializedContext,
        sessionState: this.cursor.sessionState,
      });
    }
    if (command.taskId !== undefined) this.discardTaskDeliveries(command.taskId);
    if (command.turnId !== undefined && command.turnId !== this.expectedTurnId) return;
    this.abort(
      command.turnId === undefined
        ? { tasks: command.tasks }
        : { tasks: command.tasks, turnId: command.turnId },
    );
  }

  private abort(payload: TurnCancelPayload): void {
    if (this.controller.signal.aborted) return;
    this.currentCancellation = payload;
    this.controller.abort(new TurnCancelledError());
  }

  private acceptTaskDelivery(delivery: DeliverHookPayload): boolean {
    const deliveryId = delivery.taskDeliveryId ?? delivery.caller?.taskId;
    if (deliveryId === undefined) return true;
    if (this.originatesFromCancelledTask(deliveryId) || this.seenTaskDeliveries.has(deliveryId)) {
      return false;
    }
    this.seenTaskDeliveries.add(deliveryId);
    return true;
  }

  private discardTaskDeliveries(taskId: string): void {
    this.cancelledTaskIds.add(taskId);
    const kept = this.bufferedDeliveries.filter((delivery) => {
      const deliveryId = delivery.taskDeliveryId ?? delivery.caller?.taskId;
      return deliveryId === undefined || !this.originatesFromCancelledTask(deliveryId);
    });
    this.bufferedDeliveries.splice(0, this.bufferedDeliveries.length, ...kept);
  }

  private originatesFromCancelledTask(deliveryId: string): boolean {
    return [...this.cancelledTaskIds].some(
      (taskId) => deliveryId === taskId || deliveryId.startsWith(`${taskId}:`),
    );
  }
}

function deliveryHasMessage(delivery: DeliverHookPayload): boolean {
  return delivery.payloads.some((payload) => payload.message !== undefined);
}
