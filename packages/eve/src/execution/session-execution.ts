import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { ActiveTurnInbox } from "#execution/active-turn-inbox.js";
import { SessionExecutionCursor } from "#execution/session-execution-cursor.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import {
  openWorkflowToolRunOwnerInbox,
  type WorkflowToolRunOwnerInbox,
} from "#execution/tools/workflow/owner.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import type {
  DurableStepResult,
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/turn-step.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { settleTurnStep, turnStep } from "#execution/workflow-steps.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import {
  isInboxSubagentResultFromRecordedWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { isInboxSubagentResultFromRunningHandle } from "#subagents/handles/query.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type { RunMode } from "#shared/run-mode.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

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
    const control = new ActiveTurnInbox({
      bufferedDeliveries: this.input.bufferedDeliveries,
      bufferedSessionControls: this.input.bufferedSessionControls,
      cancelledTaskIds: this.input.cancelledTaskIds,
      commandInbox: this.input.commandInbox,
      cursor: this.cursor,
      expectedTurnId: activeTurnId(this.cursor.sessionState.emissionState),
      seenTaskDeliveries: this.input.seenTaskDeliveries,
      caller: delivery.kind === "deliver" ? delivery.caller : undefined,
    });
    let nextStepInput: TurnStepPayload | undefined = delivery;

    while (true) {
      const beforeStep = {
        serializedContext: this.cursor.serializedContext,
        sessionState: this.cursor.sessionState,
      };
      const result: DurableStepResult = await control.waitFor(
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

      await this.cursor.adopt({
        serializedContext: result.serializedContext,
        sessionState:
          result.action === "cancelled"
            ? (result.backgroundTaskState ?? result.sessionState)
            : result.sessionState,
      });
      await control.admitBoundary();

      if (result.action === "cancelled") {
        return await this.finishCancelledTurn(control);
      }

      if (control.signal.aborted && (pendingCallIds === undefined || hasBackgroundTasks)) {
        return await this.finishCancelledTurn(control);
      }

      if (result.action === "done") {
        if (result.settlement !== undefined)
          await this.cursor.adopt(
            await settleTurnStep({
              ...this.cursor.createStepInput(undefined),
              settlement: result.settlement,
            }),
          );
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
        const steering: DeliverHookPayload | undefined =
          this.input.mode === "task" &&
          (result.hasPendingAuthorization || result.hasPendingInputBatch)
            ? undefined
            : control.takeSteering();
        if (steering !== undefined) {
          nextStepInput = steering;
          continue;
        }
        if (result.settlement !== undefined)
          await this.cursor.adopt(
            await settleTurnStep({
              ...this.cursor.createStepInput(undefined),
              settlement: result.settlement,
            }),
          );
        return this.outcome({
          authorizationAttemptIds: result.authorizationAttemptIds,
          authorizationNames: result.authorizationNames,
          kind: "park",
          settled: result.settled,
        });
      }

      nextStepInput = control.takeSteering();
    }
  }

  private async finishCancelledTurn(control: ActiveTurnInbox): Promise<TurnOutcome> {
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
    readonly control: ActiveTurnInbox;
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

  private async nextRuntimeEvent(control: ActiveTurnInbox): Promise<
    | RuntimeActionResultStepInput
    | {
        readonly kind: "workflow";
        readonly message: import("#execution/tools/workflow/messages.js").WorkflowToolRunMessage;
      }
    | "cancelled"
    | "cancel-turn"
  > {
    while (true) {
      const buffered = control.takeRuntimeResult();
      if (buffered !== undefined) return buffered;
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
