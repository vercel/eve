import { accountPending } from "#execution/turn/submissions.js";
import type { TurnSettlementKind } from "#execution/turn/types.js";
import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { sessionEvents } from "#execution/session/events.js";
import { sessionSnapshots } from "#execution/session/snapshots.js";
import { publishSessionDescriptor } from "#execution/session/directory.js";
import type { SessionResources, SnapshotRecordRef } from "#execution/session/resources.js";
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
import type { ModelSettlement } from "#execution/turn/model-types.js";
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

const log = createLogger("execution.turn.finalize");
const FAILURE_MESSAGE = "The turn could not complete safely.";

interface FinalizingCheckpoint extends InitializedSessionCheckpoint {
  readonly finalization: {
    readonly kind: TurnSettlementKind;
    readonly settlement?: ModelSettlement;
    readonly terminal: boolean;
  };
}

interface FinalizeTurnInput {
  readonly claimedContinuationToken?: string;
  readonly session: SessionResources;
  readonly checkpoint: SnapshotRecordRef;
  readonly kind: TurnSettlementKind;
  readonly pending: readonly InboxEnvelope[];
}

/** The owner calls this only after sealing admission to the completed model turn. */
export async function finalizeTurnStep(input: FinalizeTurnInput): Promise<TurnReceipt> {
  "use step";
  return await finalizeTurn(input);
}

async function finalizeTurn(input: FinalizeTurnInput): Promise<TurnReceipt> {
  const writeId = getStepMetadata().stepId;
  const completed = await sessionSnapshots.find<SessionCheckpoint>(
    input.session.snapshots,
    writeId,
  );
  if (completed !== undefined) {
    if (isTerminal(completed.checkpoint)) await closeSession(input.session, completed.checkpoint);
    return receipt(completed.ref, completed.checkpoint);
  }
  if ((await sessionSnapshots.find(input.session.snapshots, `${writeId}:entered`)) !== undefined) {
    throw new Error("The previous finalization attempt did not commit its effects.");
  }
  const loaded = await sessionSnapshots.read<SessionCheckpoint>(input.checkpoint);
  if (loaded.phase === "initialization-failed") return receipt(input.checkpoint, loaded);
  const original = accountPending(loaded, input.pending, input.kind);
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
  const entering: FinalizingCheckpoint = {
    ...checkpoint,
    writeId: `${writeId}:entered`,
    phase: "running",
    finalization: { kind: input.kind, settlement, terminal },
  };
  await sessionSnapshots.append(input.session.snapshots, entering);

  checkpoint = await sessionEvents.withWriter(input.session.events, async (events) => {
    let current = checkpoint;
    if (cancelling) {
      await cancelDescendantTurns({
        sessionState: current.state,
        serializedContext: current.serializedContext,
      });
      const settled = await settleCancelledTurn({
        events,
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
  const ref = await sessionSnapshots.append(input.session.snapshots, checkpoint);
  if (terminal) await closeSession(input.session, checkpoint);
  return receipt(ref, checkpoint);
}

export async function failTurnStep(input: {
  readonly session: SessionResources;
  readonly submission: AcceptedSubmission;
  readonly checkpoint?: SnapshotRecordRef;
  readonly error: string;
}): Promise<TurnReceipt> {
  "use step";
  log.error("Turn execution failed", { sessionId: input.session.sessionId, error: input.error });
  const writeId = getStepMetadata().stepId;
  const completed = await sessionSnapshots.find<SessionCheckpoint>(
    input.session.snapshots,
    writeId,
  );
  if (completed !== undefined) {
    await publishSessionDescriptor(input.session.holderRunId, input.session);
    await closeSession(input.session, completed.checkpoint);
    return receipt(completed.ref, completed.checkpoint);
  }
  const entered = await sessionSnapshots.find<SessionCheckpoint>(
    input.session.snapshots,
    `${writeId}:entered`,
  );
  if (entered?.checkpoint.phase === "initialization-failed") {
    await publishSessionDescriptor(input.session.holderRunId, input.session);
    await closeSession(input.session, entered.checkpoint);
    throw new Error("The previous initialization failure notification did not commit its effects.");
  }
  const latest =
    input.checkpoint === undefined
      ? await sessionSnapshots.latest<SessionCheckpoint>(input.session.snapshots)
      : {
          ref: input.checkpoint,
          checkpoint: await sessionSnapshots.read<SessionCheckpoint>(input.checkpoint),
        };
  if (latest !== undefined && latest.checkpoint.phase !== "initialization-failed") {
    await publishSessionDescriptor(input.session.holderRunId, input.session);
    return await finalizeTurn({
      session: input.session,
      checkpoint: latest.ref,
      kind: "failure",
      pending: [],
    });
  }
  const failed: InitializationFailureCheckpoint =
    latest?.checkpoint.phase === "initialization-failed"
      ? latest.checkpoint
      : {
          writeId: `${writeId}:entered`,
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
  const enteringRef =
    latest?.checkpoint.phase === "initialization-failed"
      ? latest.ref
      : await sessionSnapshots.append(input.session.snapshots, failed);
  if (failed.writeId !== `${writeId}:entered`) {
    await publishSessionDescriptor(input.session.holderRunId, input.session);
    await closeSession(input.session, failed);
    return receipt(enteringRef, failed);
  }
  await sessionEvents.append(input.session.events, [failed.event]);
  await notifyInitializationFailure({
    event: failed.event,
    serializedContext: {
      ...input.submission.initial?.serializedContext,
      "eve.sessionId": input.session.sessionId,
    },
  });
  await publishSessionDescriptor(input.session.holderRunId, input.session);
  const committed: InitializationFailureCheckpoint = { ...failed, writeId };
  const ref = await sessionSnapshots.append(input.session.snapshots, committed);
  await closeSession(input.session, committed);
  return receipt(ref, committed);
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

function receipt(ref: SnapshotRecordRef, checkpoint: SessionCheckpoint): TurnReceipt {
  const terminal = isTerminal(checkpoint);
  return {
    checkpoint: ref,
    deliveries: checkpoint.deliveries,
    terminal,
    ...(!terminal && checkpoint.phase !== "initialization-failed"
      ? { continuationToken: checkpoint.state.snapshot.session.continuationToken }
      : {}),
  };
}
