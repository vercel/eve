/**
 * Task-mode sibling of `dispatchRuntimeActionsStep`, selected by the turn
 * workflow when the agent enables `experimental.tasks`.
 *
 * Same plan → dispatch → emit skeleton, but every delegation is wrapped in
 * the durable task lifecycle: the task record and its inbox token
 * exist *before* the child dispatch side effect (`beginDelegatedTask`),
 * continuations pass the availability check and enter the parent session's
 * task index first, and the task settles against the dispatch outcome.
 * Children report through their task's inbox token rather than the
 * parent turn inbox, and every start dispatches a conversation-mode
 * (persistent) child so the background task stays resumable.
 *
 * Task-control calls (`task_peek` / `task_cancel` / `task_send`) execute
 * inline in this step, which holds the session ownership index and world
 * access they need.
 */

import {
  type DispatchOutcome,
  dispatchToTaskAgentAddress,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  emitSubagentCalled,
  prepareRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
  startSubagent,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  beginDelegatedTask,
  type DelegatedTask,
  executeTaskControlAction,
  settleDelegatedDispatch,
} from "#execution/tasks/parent/dispatch.js";
import {
  checkTaskContinuationAvailability,
  describeTaskDispatch,
  persistContinuationTaskInParentSession,
  settleTaskDispatchError,
  type PersistedContinuationTask,
} from "#execution/tasks/parent/continuation-dispatch.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

export async function dispatchTaskStep(
  input: RuntimeActionDispatchInput,
): Promise<RuntimeActionDispatchResult> {
  "use step";

  const prepared = await prepareRuntimeActionDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
    taskControls: true,
  });
  if (prepared === undefined) {
    return { results: [], sessionState: input.sessionState, taskReadiness: [] };
  }

  const { batch, bundle, session } = prepared;
  // Acquired only once preflight can no longer throw, so a planning failure
  // never leaks the writer lock.
  const writer = input.parentWritable.getWriter();

  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const taskReadiness: DelegatedTask[] = [];

  try {
    for (const entry of prepared.plan) {
      if (entry.kind === "reject") {
        results.push(entry.result);
        continue;
      }

      if (entry.kind === "task-control") {
        const control = await executeTaskControlAction({
          action: entry.action,
          bundle,
          parentStepIndex: batch.event.stepIndex,
          parentTurnId: batch.event.turnId,
          session: nextSession,
        });
        nextSession = control.session;
        if (control.taskReadiness !== undefined) taskReadiness.push(control.taskReadiness);
        if (control.result !== undefined) {
          results.push(control.result);
        }
        continue;
      }

      if (entry.kind === "resume") {
        const busy = await checkTaskContinuationAvailability({
          action: entry.action,
          agentId: entry.agentId,
          parentStepIndex: batch.event.stepIndex,
          parentTurnId: batch.event.turnId,
          session: nextSession,
        });
        if (busy !== undefined) {
          results.push(busy);
          continue;
        }
      }

      const delegated = await beginDelegatedTask({
        ...describeTaskDispatch({
          action: entry.kind === "resume" ? entry.action : entry.target.action,
          agentId: entry.kind === "resume" ? entry.agentId : undefined,
          parentSessionId: session.sessionId,
          parentTurnId: batch.event.turnId,
          session: nextSession,
        }),
        parentSessionId: session.sessionId,
        parentStepIndex: batch.event.stepIndex,
        parentTurnId: batch.event.turnId,
        session: nextSession,
      });
      let persistedContinuation: PersistedContinuationTask | undefined;
      if (entry.kind === "resume") {
        persistedContinuation = await persistContinuationTaskInParentSession({
          action: entry.action,
          agentId: entry.agentId,
          delegated,
          session: nextSession,
        });
        nextSession = persistedContinuation?.session ?? nextSession;
      }

      let outcome: DispatchOutcome;
      switch (entry.kind) {
        case "resume":
          outcome = await dispatchToTaskAgentAddress({
            action: entry.action,
            agentId: entry.agentId,
            bundle: createAgentContinuationBundle({
              action: entry.action,
              bundle,
              dynamicRemoteAgent: entry.dynamicRemoteAgent,
            }),
            currentSession: nextSession,
            parentToken: delegated.taskInboxToken,
          });
          break;
        case "start":
          outcome = await startSubagent({
            auth: prepared.auth,
            batchEvent: batch.event,
            bundle,
            callbackBaseUrl: input.callbackBaseUrl,
            capabilities: prepared.capabilities,
            channelMetadata: prepared.channelMetadata,
            currentSession: nextSession,
            fanoutSize: prepared.fanoutSize,
            initiatorAuth: prepared.initiatorAuth,
            parentContinuationToken: delegated.taskInboxToken,
            parentTraceContext: prepared.parentTraceContext,
            // Background tasks require resumable children, so task mode
            // always dispatches conversation-mode (persistent) sessions;
            // `experimental.subagentPersistentSessions` never produces a
            // third mode here.
            persistentSessions: true,
            session,
            taskOwned: true,
            target: entry.target,
          });
          break;
      }

      nextSession = outcome.session;
      if (outcome.kind === "error") {
        results.push(
          await settleTaskDispatchError({
            agentId: entry.kind === "resume" ? entry.agentId : undefined,
            delegated,
            outcome,
            persisted: persistedContinuation,
            session: nextSession,
          }),
        );
        if (persistedContinuation !== undefined) taskReadiness.push(delegated);
        continue;
      }

      if (persistedContinuation !== undefined) {
        results.push(persistedContinuation.receipt);
      } else {
        const settled = await settleDelegatedDispatch({
          callId: outcome.callId,
          session: nextSession,
          subagentName: outcome.toolName,
          task: delegated,
        });
        nextSession = settled.session;
        results.push(settled.receipt);
      }
      taskReadiness.push(delegated);

      await emitSubagentCalled({
        adapter: prepared.adapter,
        adapterCtx: prepared.adapterCtx,
        batchEvent: batch.event,
        entry,
        outcome,
        sessionId: session.sessionId,
        writer,
      });
    }
  } finally {
    writer.releaseLock();
  }

  return {
    results,
    sessionState:
      nextSession === session
        ? input.sessionState
        : createDurableSessionState({ session: nextSession }),
    taskReadiness,
  };
}
