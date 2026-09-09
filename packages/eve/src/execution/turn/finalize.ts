import { selectDeliveries } from "#execution/turn/receipts.js";
import { accountPending } from "#execution/turn/submissions.js";
import type { TurnSettlementKind } from "#execution/turn/types.js";
import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { sessionEvents } from "#execution/session/events.js";
import { sessionSnapshots } from "#execution/session/snapshots.js";
import { publishSessionDescriptor } from "#execution/session/directory.js";
import type { SessionResources } from "#execution/session/resources.js";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import type {
  AcceptedSubmission,
  InitializedSessionCheckpoint,
  InitializationFailureCheckpoint,
  SessionCheckpoint,
  TurnReceipt,
} from "#execution/turn/types.js";
import { finalizeModelSettlement } from "#execution/turn/finalize-model.js";
import { cancellationSettlement, settleCancelledTurn } from "#execution/turn/cancel.js";
import { cancelDescendantTurns } from "#execution/turn/cancel-descendants.js";
import { terminateChildSessions } from "#execution/turn/terminate-children.js";
import { cancelSessionTimeout } from "#execution/session-timeout-steps.js";
import {
  notifyCancelledTaskCaller,
  notifyDelegatedParent,
  notifyTurnCaller,
} from "#subagents/parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#subagents/parent-result.js";
import { fireSessionCallback } from "#subagents/callbacks.js";
import {
  createSessionCompletedEvent,
  createSessionFailedEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { createLogger } from "#internal/logging.js";
import { notifyInitializationFailure } from "#execution/turn/initialization-failure.js";
import { cancelAllIndexedSessionTasksStep } from "#execution/cancel-indexed-session-tasks-step.js";

const log = createLogger("execution.turn.finalize");
const FAILURE_MESSAGE = "The turn could not complete safely.";

interface FinalizeTurnInput {
  readonly eventIds: readonly string[];
  readonly claimedContinuationToken?: string;
  readonly session: SessionResources;
  readonly checkpoint: InitializedSessionCheckpoint;
  readonly kind: TurnSettlementKind;
  readonly pending: readonly InboxEnvelope[];
}

/** The owner calls this only after sealing admission to the completed model turn. */
export async function finalizeTurnStep(input: FinalizeTurnInput): Promise<SessionCheckpoint> {
  "use step";
  return await finalizeTurn(input);
}

async function finalizeTurn(input: FinalizeTurnInput): Promise<SessionCheckpoint> {
  const writeId = getStepMetadata().stepId;
  const original = accountPending(input.checkpoint, input.pending, input.kind);
  if (
    input.pending.some((event) => {
      if (event.kind !== "session.submit") return false;
      const command = (event.payload as { submission: AcceptedSubmission }).submission.command;
      return command.kind === "cancel" && command.tasks === true;
    })
  )
    await cancelAllIndexedSessionTasksStep({
      sessionState: original.state,
      serializedContext: original.serializedContext,
    });
  const result = original.result;
  const cancelling =
    input.kind === "cancel" ||
    input.kind === "interrupt" ||
    input.kind === "reset" ||
    input.kind === "timeout";
  const terminal =
    input.kind === "reset" ||
    input.kind === "timeout" ||
    input.kind === "failure" ||
    (input.kind === "natural" && result?.action === "done");
  let checkpoint = cancelling
    ? {
        ...original,
        state: result?.cancellationState ?? original.state,
        serializedContext: result?.cancellationContext ?? original.serializedContext,
      }
    : original;
  let settlement = input.kind === "natural" ? result?.settlement : undefined;
  if (cancelling) {
    settlement = cancellationSettlement(
      checkpoint.state,
      input.kind === "interrupt" ? "interrupt" : terminal ? "terminal" : "cancel",
    );
  }
  if (terminal && input.kind !== "natural") {
    const event =
      input.kind === "failure"
        ? createSessionFailedEvent({
            sessionId: input.session.sessionId,
            code: "TURN_EXECUTION_FAILED",
            message: FAILURE_MESSAGE,
          })
        : createSessionCompletedEvent();
    settlement = {
      events: [...(settlement?.events ?? []), stampMessageStreamEvent(event)],
      emissionAfter: settlement?.emissionAfter ?? checkpoint.state.emissionState,
    };
  }
  checkpoint = await sessionEvents.withWriter(input.session.events, async (events) => {
    let current = checkpoint;
    if (cancelling) {
      await cancelDescendantTurns({
        sessionState: original.state,
        serializedContext: original.serializedContext,
      });
      const settled = await settleCancelledTurn({
        events,
        ownershipState: original.state,
        sessionState: current.state,
        serializedContext: current.serializedContext,
        settlement: settlement!,
      });
      current = {
        ...current,
        state: settled.sessionState,
        serializedContext: settled.serializedContext,
      };
      await notifyCancelledTaskCaller({
        caller: current.caller,
        lifecycle: terminal ? "terminal" : "parked",
        sessionId: input.session.sessionId,
        usage: settled.usage,
      });
      current = { ...current, caller: undefined };
    } else if (settlement !== undefined) {
      const settled = await finalizeModelSettlement({
        events,
        sessionState: current.state,
        serializedContext: current.serializedContext,
        settlement,
      });
      current = {
        ...current,
        state: settled.sessionState,
        serializedContext: settled.serializedContext,
      };
    }
    const outcome =
      result?.action === "done"
        ? { output: result.output ?? "", isError: result.isError, usage: result.usageDelta }
        : result?.action === "park"
          ? result.settled
          : undefined;
    if (input.kind === "natural" && outcome !== undefined) {
      await notifyTurnCaller({
        caller: current.caller,
        lifecycle: terminal ? "terminal" : "parked",
        sessionId: input.session.sessionId,
        settled: outcome,
      });
      current = { ...current, caller: undefined };
    } else if (input.kind === "failure" && current.caller !== undefined) {
      await notifyTurnCaller({
        caller: current.caller,
        lifecycle: "terminal",
        sessionId: input.session.sessionId,
        settled: { isError: true, output: FAILURE_MESSAGE },
      });
      current = { ...current, caller: undefined };
    }
    if (terminal) {
      await terminateChildSessions({
        sessionState: current.state,
        serializedContext: current.serializedContext,
      });
      if (current.serializedContext["eve.mode"] === "task") {
        const failed =
          input.kind !== "natural" || (result?.action === "done" && result.isError === true);
        const output =
          input.kind === "natural" && result?.action === "done" ? result.output : FAILURE_MESSAGE;
        const usage = result?.action === "done" ? result.usage : undefined;
        await fireSessionCallback({
          serializedContext: current.serializedContext,
          status: failed ? "failed" : "completed",
          output: failed ? undefined : output,
          error: failed ? output : undefined,
          usage,
        });
        await notifyDelegatedParent({
          serializedContext: current.serializedContext,
          result: failed
            ? createDelegatedSubagentErrorResult(current.serializedContext, output)
            : createDelegatedSubagentSuccessResult(current.serializedContext, output),
          usage,
        });
      }
    }
    return current;
  });

  const deliveries = { ...checkpoint.deliveries };
  if (terminal)
    for (const item of checkpoint.queue) deliveries[item.submission.eventId] = "retired";
  checkpoint = {
    ...checkpoint,
    writeId,
    phase: terminal ? "terminal" : "settled",
    claimedContinuationToken: input.claimedContinuationToken ?? checkpoint.claimedContinuationToken,
    deliveries,
    queue: terminal ? [] : checkpoint.queue,
    inputs: [],
    result: undefined,
  };
  return checkpoint;
}

export async function failTurnStep(input: {
  readonly eventIds: readonly string[];
  readonly session: SessionResources;
  readonly submission: AcceptedSubmission;
  readonly checkpoint?: InitializedSessionCheckpoint;
  readonly error: string;
}): Promise<SessionCheckpoint> {
  "use step";
  log.error("Turn execution failed", { sessionId: input.session.sessionId, error: input.error });
  const writeId = getStepMetadata().stepId;
  const latest =
    input.checkpoint === undefined
      ? await sessionSnapshots.latest<SessionCheckpoint>(input.session.snapshots)
      : input.checkpoint;
  if (latest != null && isTerminal(latest)) return latest;
  if (latest != null && latest.phase !== "initialization-failed") {
    await publishSessionDescriptor(input.session.holderRunId, input.session);
    return await finalizeTurn({
      session: input.session,
      checkpoint: latest,
      kind: "failure",
      eventIds: input.eventIds,
      pending: [],
    });
  }
  const failed: InitializationFailureCheckpoint = {
    writeId,
    writerRunId: getWorkflowMetadata().workflowRunId,
    phase: "initialization-failed",
    deliveries: { [input.submission.eventId]: "retired" },
    queue: [],
    event: stampMessageStreamEvent(
      createSessionFailedEvent({
        sessionId: input.session.sessionId,
        code: "SESSION_INITIALIZATION_FAILED",
        message: "The session could not initialize.",
      }),
    ),
  };
  await sessionEvents.append(input.session.events, [failed.event]);
  await notifyInitializationFailure({
    event: failed.event,
    serializedContext: {
      ...input.submission.initial?.serializedContext,
      "eve.sessionId": input.session.sessionId,
    },
  });
  await publishSessionDescriptor(input.session.holderRunId, input.session);
  return failed;
}

/** Persist the settled step result before releasing the turn claim. Retrying cannot rerun lifecycle effects. */
export async function commitTurnStep(input: {
  readonly session: SessionResources;
  readonly checkpoint: SessionCheckpoint;
  readonly eventIds: readonly string[];
}): Promise<TurnReceipt> {
  "use step";
  await sessionSnapshots.append(input.session.snapshots, input.checkpoint);
  return receipt(input.checkpoint, input.eventIds);
}

export async function closeSessionStep(
  session: SessionResources,
  checkpoint: SessionCheckpoint,
): Promise<void> {
  "use step";
  await closeSession(session, checkpoint);
}

function isTerminal(checkpoint: SessionCheckpoint): boolean {
  return checkpoint.phase === "terminal" || checkpoint.phase === "initialization-failed";
}

async function closeSession(
  session: SessionResources,
  checkpoint: SessionCheckpoint,
): Promise<void> {
  await sessionEvents.close(session.events);
  await sessionSnapshots.close(session.snapshots);
  if (checkpoint.phase !== "initialization-failed" && checkpoint.timeoutRunId !== undefined) {
    await cancelSessionTimeout({ runId: checkpoint.timeoutRunId });
  }
  const collector =
    checkpoint.phase === "initialization-failed" ? undefined : checkpoint.activityCollectorRunId;
  for (const runId of [collector, session.holderRunId]) {
    if (runId === undefined) continue;
    try {
      await cancelRun(await getWorld(), runId);
    } catch (error) {
      if (!isTaskWorkflowTargetGone(error)) throw error;
    }
  }
}

function receipt(checkpoint: SessionCheckpoint, eventIds: readonly string[]): TurnReceipt {
  const terminal = isTerminal(checkpoint);
  return {
    deliveries: selectDeliveries(checkpoint.deliveries, eventIds),
    terminal,
    ...(!terminal && checkpoint.phase !== "initialization-failed"
      ? { continuationToken: checkpoint.state.snapshot.session.continuationToken }
      : {}),
  };
}
