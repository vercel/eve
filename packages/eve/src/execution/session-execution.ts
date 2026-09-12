import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionCapabilities } from "#channel/types.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import type { SessionBacklog } from "#execution/session-backlog.js";
import type { SessionInbox } from "#execution/session-inbox/inbox.js";
import type { SessionStateCursor } from "#execution/session-state-cursor.js";
import { TurnRouting } from "#execution/turn-routing.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { handleWorkflowToolRunMessage } from "#execution/session-workflow-tool-run.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import type {
  DurableStepResult,
  RuntimeActionResultStepInput,
  TurnOutcome,
  TurnStepPayload,
} from "#execution/turn-step.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { commitSettlementStep, turnStep } from "#execution/workflow-steps.js";
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

type RuntimeEvent =
  | RuntimeActionResultStepInput
  | { readonly kind: "workflow"; readonly message: WorkflowToolRunMessage }
  | "cancelled";

/**
 * Executes conversational turns inside the owning session workflow: runs
 * `turnStep`, services the inbox at committed boundaries, coordinates waits,
 * and settles locally. There is no child run and no transport protocol.
 */
export interface SessionExecutionInput {
  readonly backlog: SessionBacklog;
  readonly capabilities?: SessionCapabilities;
  readonly commandInbox: SessionInbox;
  readonly cursor: SessionStateCursor;
  readonly mode: RunMode;
}

export class SessionExecution {
  private readonly input: SessionExecutionInput;

  constructor(input: SessionExecutionInput) {
    this.input = input;
  }

  get cursor(): SessionStateCursor {
    return this.input.cursor;
  }

  async runTurn(delivery: TurnStepPayload): Promise<TurnOutcome> {
    const { backlog, commandInbox, cursor } = this.input;
    const control = new TurnRouting({
      backlog,
      callerCallId: delivery.kind === "deliver" ? delivery.caller?.callId : undefined,
      commandInbox,
      cursor,
      expectedTurnId: activeTurnId(cursor.sessionState.emissionState),
    });
    let nextStepInput: TurnStepPayload | undefined = delivery;

    while (true) {
      const beforeStepContext = cursor.serializedContext;
      const result: DurableStepResult = await control.waitFor(
        turnStep(cursor.createStepInput(nextStepInput, control.signal)),
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
        await cursor.adopt({
          serializedContext: result.backgroundTaskContext ?? beforeStepContext,
          sessionState: result.backgroundTaskState,
        });
        await acknowledgeDelegatedTasksStep({ tasks: result.backgroundTasks ?? [] });
      }

      await cursor.adopt({
        serializedContext: result.serializedContext,
        sessionState:
          result.action === "cancelled" || control.signal.aborted
            ? (result.backgroundTaskState ?? result.sessionState)
            : result.sessionState,
      });
      await control.admitBoundary();

      if (result.action === "cancelled") return await this.finishCancelledTurn(control);
      if (control.signal.aborted && (pendingCallIds === undefined || hasBackgroundTasks)) {
        return await this.finishCancelledTurn(control);
      }

      if (result.action === "done") {
        await this.commitSettlement(result);
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
          workflowToolRunOwner: { inbox: commandInbox.sessionHookTokens[0]! },
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        const initialAcceptedAtMs = dispatchResult.results.length === 0 ? undefined : Date.now();
        await cursor.adopt(dispatchResult);
        await acknowledgeDelegatedTasksStep({ tasks: dispatchResult.pendingTasks });

        const results = await this.waitForRuntimeActionResults({
          control,
          initialAcceptedAtMs,
          initialResults: dispatchResult.results,
          pendingCallIds,
        });
        if (results === "cancelled") return await this.finishCancelledTurn(control);
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
        await this.commitSettlement(result);
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

  async handleWorkflowMessage(
    message: WorkflowToolRunMessage,
  ): Promise<RuntimeActionResult | undefined> {
    return await handleWorkflowToolRunMessage({
      callbackMetadataUrl: getWorkflowMetadata().url,
      cursor: this.input.cursor,
      message,
    });
  }

  /** Commits terminal turn events only after steering had its chance at the boundary. */
  private async commitSettlement(result: DurableStepResult): Promise<void> {
    if (result.settlement === undefined) return;
    await this.input.cursor.adopt(
      await commitSettlementStep({
        ...this.input.cursor.createStepInput(undefined),
        settlement: result.settlement,
      }),
    );
  }

  private async finishCancelledTurn(control: TurnRouting): Promise<TurnOutcome> {
    const { cursor } = this.input;
    if (control.cancellation?.tasks === true) {
      await cancelAllIndexedSessionTasksStep({
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      });
    }
    await cancelDescendantTurnsStep({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
    return this.outcome({ cancelled: true, kind: "park" });
  }

  private outcome<T extends Omit<TurnOutcome, "serializedContext" | "sessionState">>(
    value: T,
  ): TurnOutcome {
    return {
      ...value,
      serializedContext: this.input.cursor.serializedContext,
      sessionState: this.input.cursor.sessionState,
    } as TurnOutcome;
  }

  private async waitForRuntimeActionResults(input: {
    readonly control: TurnRouting;
    readonly initialAcceptedAtMs: number | undefined;
    readonly initialResults: readonly RuntimeActionResult[];
    readonly pendingCallIds: readonly string[];
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
          kind: "runtime-action-result",
          results: ready,
        };
      }

      const next = await this.nextRuntimeEvent(input.control);
      if (next === "cancelled") return next;
      if (next.kind === "runtime-action-result") {
        const snapshot = this.input.cursor.sessionState.snapshot.session.state;
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

      const result = await this.handleWorkflowMessage(next.message);
      if (result !== undefined) {
        results.push(result);
        acceptedAtMsByCallId.set(result.callId, Date.now());
      }
    }
  }

  private async nextRuntimeEvent(control: TurnRouting): Promise<RuntimeEvent> {
    const { commandInbox } = this.input;
    while (true) {
      if (control.signal.aborted) return "cancelled";
      const result = control.takeRuntimeResult();
      if (result !== undefined) return result;
      const message = control.takeWorkflowMessage();
      if (message !== undefined) return { kind: "workflow", message };
      const read = await commandInbox.next("runtime");
      if (read.done) throw new Error("Session inbox closed before runtime actions completed.");
      commandInbox.consumeNext("runtime");
      await control.handle(read.value, true);
    }
  }
}
