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
 * Agents running `experimental.tasks` never reach this step: the turn
 * workflow selects `dispatchTaskStep`, the task-mode sibling that wraps
 * each dispatch in the delegated-task lifecycle.
 */

import { type DispatchOutcome, dispatchToAgentHandle } from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  emitSubagentCalled,
  prepareRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
  startSubagent,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

export async function dispatchRuntimeActionsStep(
  input: RuntimeActionDispatchInput,
): Promise<RuntimeActionDispatchResult> {
  "use step";

  const prepared = await prepareRuntimeActionDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
    taskControls: false,
  });
  if (prepared === undefined) {
    return { results: [], sessionState: input.sessionState, taskReadiness: [] };
  }

  const { batch, bundle, session } = prepared;
  const persistentSessions =
    bundle.resolvedAgent.config.experimental?.subagentPersistentSessions === true;
  // Acquired only once preflight can no longer throw, so a planning failure
  // never leaks the writer lock.
  const writer = input.parentWritable.getWriter();

  let nextSession = session;
  const results: RuntimeActionResult[] = [];

  try {
    for (const entry of prepared.plan) {
      if (entry.kind === "reject") {
        results.push(entry.result);
        continue;
      }
      if (entry.kind === "task-control") {
        // Unreachable: the plan was built with `taskControls: false`.
        throw new Error("Task-control actions require the task dispatch step.");
      }

      let outcome: DispatchOutcome;
      switch (entry.kind) {
        case "resume":
          outcome = await dispatchToAgentHandle({
            action: entry.action,
            agentId: entry.agentId,
            bundle: createAgentContinuationBundle({
              action: entry.action,
              bundle,
              dynamicRemoteAgent: entry.dynamicRemoteAgent,
            }),
            currentSession: nextSession,
            parentToken: input.parentContinuationToken ?? session.continuationToken,
            parentTurnId: batch.event.turnId,
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
            parentContinuationToken: input.parentContinuationToken,
            parentTraceContext: prepared.parentTraceContext,
            persistentSessions,
            session,
            taskOwned: false,
            target: entry.target,
          });
          break;
      }

      nextSession = outcome.session;
      if (outcome.kind === "error") {
        results.push(outcome.result);
        continue;
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
    taskReadiness: [],
  };
}
