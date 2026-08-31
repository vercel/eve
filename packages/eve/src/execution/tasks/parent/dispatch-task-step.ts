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
 * Task-control calls (`task_cancel` / `task_update`) execute
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
  startWorkflowTool,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { deriveChildActivityObserverConfig } from "#execution/activity-work.js";
import {
  beginDelegatedTask,
  type DelegatedTask,
  settleDelegatedDispatch,
} from "#execution/tasks/parent/delegate.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import {
  checkTaskContinuationAvailability,
  describeTaskDispatch,
  persistContinuationTaskInParentSession,
  settleTaskDispatchError,
  type PersistedContinuationTask,
} from "#execution/tasks/parent/continuation-dispatch.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

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
    return { results: [], sessionState: input.sessionState, pendingTasks: [] };
  }

  const { batch, bundle, session } = prepared;
  // Acquired only once preflight can no longer throw, so a planning failure
  // never leaks the writer lock.
  const writer = input.parentWritable.getWriter();

  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const pendingTasks: DelegatedTask[] = [];

  try {
    for (const entry of prepared.plan) {
      if (entry.kind === "reject") {
        results.push(entry.result);
        continue;
      }
      if (entry.kind === "workflow-tool") {
        const started = await startWorkflowTool({
          action: entry.action,
          batchEvent: batch.event,
          ownerInboxToken: input.parentContinuationToken,
          prepared,
          session: nextSession,
        });
        nextSession = started.session;
        if (started.result !== undefined) results.push(started.result);
        continue;
      }

      if (entry.kind === "task-control") {
        const control = await executeTaskControlAction({
          action: entry.action,
          adapter: prepared.adapter,
          bundle,
          parentStepIndex: batch.event.stepIndex,
          parentTurnId: batch.event.turnId,
          serializedContext: prepared.serializedContext,
          session: nextSession,
        });
        nextSession = control.session;
        if (control.pendingTask !== undefined) pendingTasks.push(control.pendingTask);
        results.push(control.result);
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

      const action = entry.kind === "resume" ? entry.action : entry.target.action;
      const delegated = await beginDelegatedTask({
        ...describeTaskDispatch({
          action,
          agentId: entry.kind === "resume" ? entry.agentId : undefined,
          parentSessionId: session.sessionId,
          parentTurnId: batch.event.turnId,
          session: nextSession,
        }),
        activityObserver:
          prepared.activityObserver === undefined
            ? undefined
            : deriveChildActivityObserverConfig({
                activityObserver: prepared.activityObserver,
                callId: action.callId,
                kind: "task",
                name: entry.kind === "resume" ? entry.action.name : entry.target.action.name,
                parentSessionId: session.sessionId,
                parentTurnId: batch.event.turnId,
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
            activityObserver:
              prepared.activityObserver === undefined
                ? undefined
                : deriveChildActivityObserverConfig({
                    activityObserver: prepared.activityObserver,
                    callId: entry.action.callId,
                    kind: "task",
                    name: entry.action.name,
                    parentSessionId: session.sessionId,
                    parentTurnId: batch.event.turnId,
                  }),
            agentId: entry.agentId,
            auth: prepared.auth,
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
            localDevRequest: prepared.localDevRequest,
            parentContinuationToken: delegated.taskInboxToken,
            parentTraceContext: prepared.parentTraceContext,
            activityObserver: prepared.activityObserver,
            sandboxSessionId: prepared.sandboxSessionId,
            serializedContext: prepared.serializedContext,
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
            delegated,
            outcome,
            persisted: persistedContinuation,
          }),
        );
        if (persistedContinuation !== undefined) pendingTasks.push(delegated);
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
      pendingTasks.push(delegated);

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
    pendingTasks,
  };
}
