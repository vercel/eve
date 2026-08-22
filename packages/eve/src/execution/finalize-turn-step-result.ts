import type { ContextContainer } from "#context/container.js";
import type { AgentLoopBatch } from "#execution/agent-loop-batch.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { DurableStepResult } from "#execution/next-driver-action.js";
import { derivePendingState } from "#execution/pending-turn-state.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { readTurnSleepDurationMs } from "#harness/turn-sleep.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";
import type { RunMode } from "#shared/run-mode.js";
import { serializeContext } from "#context/serialize.js";

const TASK_DONE_WITH_PENDING_INPUT_ERROR_MESSAGE =
  "Task mode cannot complete while input requests remain pending.";

export async function finalizeTurnStepResult(input: {
  readonly batch: AgentLoopBatch;
  readonly ctx: ContextContainer;
  readonly mode: RunMode;
  readonly tasksEnabled: boolean;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly stepResult: StepResult;
}): Promise<DurableStepResult> {
  let stepResult = {
    ...input.stepResult,
    session: reconcileSessionContinuationToken(input.ctx, input.stepResult.session),
  };
  const serializedContext = serializeContext(input.ctx);
  const sessionState = createDurableSessionState({ session: stepResult.session });
  const checkpointTransition = input.batch.cancellationTransition();
  const backgroundTaskState =
    stepResult.backgroundTasks === undefined || stepResult.backgroundTaskSession === undefined
      ? undefined
      : createDurableSessionState({ session: stepResult.backgroundTaskSession });
  const cancellationTransition =
    backgroundTaskState === undefined
      ? checkpointTransition
      : {
          serializedContext:
            checkpointTransition?.serializedContext ?? input.batch.checkpointSerializedContext(),
          sessionState: backgroundTaskState,
        };
  const commitBarrier =
    backgroundTaskState === undefined || stepResult.backgroundTasks === undefined
      ? undefined
      : {
          effect: { kind: "release-background-tasks" as const, tasks: stepResult.backgroundTasks },
          transition: cancellationTransition!,
        };
  const transitions = { cancellationTransition, commitBarrier };
  const sleepDurationMs = readTurnSleepDurationMs(input.ctx);
  const sleep = sleepDurationMs === undefined ? {} : { sleepDurationMs };

  if (
    stepResult.next !== null &&
    typeof stepResult.next === "object" &&
    "done" in stepResult.next
  ) {
    if (input.mode === "task" && hasPendingInputBatch(stepResult.session.state)) {
      input.writer.releaseLock();
      throw new Error(TASK_DONE_WITH_PENDING_INPUT_ERROR_MESSAGE);
    }
    await input.writer.close();
    const sessionTotals = getTurnUsageState(stepResult.session.state)?.session;
    return {
      action: "done",
      ...transitions,
      output: stepResult.next.output,
      isError: stepResult.next.isError,
      ...sleep,
      serializedContext,
      sessionState,
      usage: sessionTotals === undefined ? undefined : toUsage(sessionTotals),
      usageDelta: takeSessionUsageDelta(stepResult.session).delta,
    };
  }

  if (stepResult.next === null) {
    input.writer.releaseLock();
    const workflowInterrupt = getPendingWorkflowInterrupt(stepResult.session.state);
    if (
      workflowInterrupt !== undefined &&
      isWorkflowRuntimeActionInterrupt(workflowInterrupt.interrupt)
    ) {
      return {
        action: "dispatch-workflow-runtime-actions",
        ...transitions,
        pendingRuntimeActionKeys: getRuntimeActionKeysFromWorkflowInterrupt(
          workflowInterrupt.interrupt,
        ),
        ...sleep,
        serializedContext,
        sessionState,
      };
    }

    const pending = derivePendingState(stepResult.session);
    if (stepResult.settledTurn !== undefined) {
      const { delta, session: reportedSession } = takeSessionUsageDelta(stepResult.session);
      return {
        action: "park",
        ...transitions,
        ...pending,
        ...sleep,
        serializedContext,
        sessionState: createDurableSessionState({ session: reportedSession }),
        settled: {
          output: stepResult.settledTurn.output,
          isError: stepResult.settledTurn.isError,
          usage: delta,
        },
        tasksEnabled: input.tasksEnabled,
      };
    }

    return {
      action: "park",
      ...transitions,
      ...pending,
      ...sleep,
      serializedContext,
      sessionState,
      tasksEnabled: input.tasksEnabled,
    };
  }

  input.writer.releaseLock();
  return {
    action: "continue",
    ...transitions,
    ...sleep,
    serializedContext,
    sessionState,
  };
}
