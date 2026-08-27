/**
 * Starts or continues every pending runtime action for the parked parent
 * session, with children reporting straight back to the parent turn via
 * `parentContinuationToken`.
 *
 * The batch is classified into a dispatch plan first (reject / resume /
 * start), then each entry dispatches and emits one
 * parent `subagent.called` control-plane event through a single tail.
 * Every start commits an agent handle (`starting`) before its side effect
 * and confirms it (`running`) once the child reports coordinates, so the
 * returned snapshot-bearing state owns every child it may have created.
 *
 * Background definitions execute during the model step through the task
 * runtime. This step owns the remaining blocking actions and task controls.
 */

import {
  createAgentContinuationMismatch,
  type DispatchOutcome,
  dispatchToAgentHandle,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  emitSubagentCalled,
  prepareRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
  startWorkflowTool,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#shared/action-types.js";
import { recordToolRun } from "#harness/tool-runs.js";
import {
  createSubagentToolRunSession,
  settleSubagentToolRunDispatchFailure,
  startSubagentToolRun,
} from "#execution/tools/subagent/run.js";
import { startBlockingSubagent } from "#execution/tools/subagent/blocking.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import type { DelegatedTask } from "#execution/tasks/parent/delegate.js";

export async function dispatchRuntimeActionsStep(
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
          parentContinuationToken: input.parentContinuationToken ?? session.continuationToken,
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

      let outcome: DispatchOutcome;
      switch (entry.kind) {
        case "resume":
          const mismatch = createAgentContinuationMismatch({
            action: entry.action,
            agentId: entry.agentId,
            currentSession: nextSession,
            execution: "blocking",
          });
          if (mismatch !== undefined) {
            const run = await startSubagentToolRun({
              action: entry.action,
              ownerToken: input.parentContinuationToken ?? session.continuationToken,
              session: createSubagentToolRunSession({
                auth: { current: prepared.auth, initiator: prepared.initiatorAuth },
                id: session.sessionId,
                parent: prepared.parentSession,
                sequence: batch.event.sequence,
                turnId: batch.event.turnId,
              }),
              stepIndex: batch.event.stepIndex,
            });
            nextSession = recordSubagentToolRun(nextSession, entry.action, run);
            if (!run.replyReady) continue;
            await settleSubagentToolRunDispatchFailure({
              replyToken: run.replyToken,
              result: mismatch,
            });
            continue;
          }
          const run = await startSubagentToolRun({
            action: entry.action,
            ownerToken: input.parentContinuationToken ?? session.continuationToken,
            session: createSubagentToolRunSession({
              auth: { current: prepared.auth, initiator: prepared.initiatorAuth },
              id: session.sessionId,
              parent: prepared.parentSession,
              sequence: batch.event.sequence,
              turnId: batch.event.turnId,
            }),
            stepIndex: batch.event.stepIndex,
          });
          if (!run.replyReady) {
            nextSession = recordSubagentToolRun(nextSession, entry.action, run);
            continue;
          }
          outcome = await dispatchToAgentHandle({
            action: entry.action,
            agentId: entry.agentId,
            auth: prepared.auth,
            bundle: createAgentContinuationBundle({
              action: entry.action,
              bundle,
              dynamicRemoteAgent: entry.dynamicRemoteAgent,
            }),
            currentSession: nextSession,
            parentToken: run.replyToken,
            parentTurnId: batch.event.turnId,
          });
          nextSession = recordSubagentToolRun(outcome.session, entry.action, run);
          if (outcome.kind === "error") {
            await settleSubagentToolRunDispatchFailure({
              replyToken: run.replyToken,
              result: outcome.result,
            });
            continue;
          }
          break;
        case "start":
          const started = await startBlockingSubagent({
            action: entry.target.action,
            auth: prepared.auth,
            batchEvent: batch.event,
            bundle,
            callbackBaseUrl: input.callbackBaseUrl,
            capabilities: prepared.capabilities,
            channelMetadata: prepared.channelMetadata,
            currentSession: nextSession,
            fanoutSize: prepared.fanoutSize,
            initiatorAuth: prepared.initiatorAuth,
            ownerToken: input.parentContinuationToken ?? session.continuationToken,
            parentSession: prepared.parentSession,
            parentTraceContext: prepared.parentTraceContext,
            sandboxSessionId: prepared.sandboxSessionId,
            serializedContext: prepared.serializedContext,
            session,
            stepIndex: batch.event.stepIndex,
            target: entry.target,
          });
          if (started.outcome === undefined) {
            nextSession = recordSubagentToolRun(nextSession, entry.target.action, started.run);
            continue;
          }
          outcome = started.outcome;
          nextSession = recordSubagentToolRun(outcome.session, entry.target.action, started.run);
          if (outcome.kind === "error") {
            await settleSubagentToolRunDispatchFailure({
              replyToken: started.run.replyToken,
              result: outcome.result,
            });
            continue;
          }
          break;
      }

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

function recordSubagentToolRun(
  session: Parameters<typeof createDurableSessionState>[0]["session"],
  action: RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest,
  run: Awaited<ReturnType<typeof startSubagentToolRun>>,
) {
  return recordToolRun(session, {
    callId: action.callId,
    hookToken: run.hookToken,
    runId: run.runId,
    resultKind: "subagent",
    toolName: action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName,
  });
}
