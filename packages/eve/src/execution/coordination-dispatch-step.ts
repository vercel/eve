/** Starts workflow-tool runs for pending coordination. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { publishSessionEvents } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { startWorkflowTask, type StartWorkflowTaskInput } from "#execution/tools/workflow/start.js";
import { sendToTask, startTaskRun } from "#execution/tasks/start.js";
import {
  captureAgentSessionContext,
  resolveStepAgentLimits,
} from "#execution/agent-sessions/context.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { startTask, type TaskCallStart } from "#harness/session-machine/transitions.js";
import { publicViewOf } from "#harness/session-machine/closure.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { callSettledFrom } from "#harness/call-facts.js";
import { cloneView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

export async function dispatchCoordinationStep(
  input: CoordinationDispatchInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await withSessionStateDelta(input, dispatchCoordination);
}

async function dispatchCoordination(
  input: CoordinationDispatchInput,
): Promise<CoordinationDispatchResult> {
  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  if (prepared === undefined) {
    return {
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const started: TaskCallStart[] = [];
  const refused: SessionEvent[] = [];
  const agentLimits = resolveStepAgentLimits(prepared);
  // Prospective facts for this admission batch use the same fold as committed facts. This
  // shadow is never saved: limits count work actually started earlier in the batch without
  // introducing a private lifecycle counter or treating undispatched intents as queued work.
  const admissionView = cloneView(publicViewOf(storedProjection(session.state)));

  for (const task of prepared.plan) {
    const start = {
      agentContext: captureAgentSessionContext(prepared, task.callId, agentLimits),
      auth: {
        current: prepared.auth,
        initiator: prepared.initiatorAuth,
      },
      batchEvent: batch.event,
      owner: input.workflowToolRunOwner,
      parentSession: prepared.parentSession,
      session: nextSession,
      task,
    };
    const dispatched = await dispatchWorkflowCall(start, admissionView);
    nextSession = dispatched.session;
    if (dispatched.result !== undefined) results.push(dispatched.result);
    if (dispatched.started !== undefined) {
      started.push(dispatched.started);
      const shadow = sessionView(
        { ...storedProjection(nextSession.state), view: admissionView },
        nextSession.state,
      );
      foldLine(
        admissionView,
        { at: new Date().toISOString(), facts: startTask(shadow, dispatched.started).events },
        admissionView.position,
      );
    }
    if (dispatched.refusal !== undefined && dispatched.result !== undefined)
      refused.push(
        callSettledFrom(dispatched.result, {
          rejected: true,
          cause: { policy: dispatched.refusal },
          scope: { turnId: batch.event.turnId },
        }),
      );
  }

  const view = sessionView(storedProjection(nextSession.state), nextSession.state);
  // One introduction per task in this commit, based on the public table and this batch's
  // pending facts, not the private runtime address (which can exist before publication).
  const introducedTasks = new Set(Object.keys(publicViewOf(view.projection).tasks));
  const published = await publishSessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState:
        nextSession === session
          ? prepared.sessionState
          : createDurableSessionState({ session: nextSession }),
      sessionWritable: input.sessionWritable,
    },
    [...started.flatMap((task) => startTask(view, task, introducedTasks).events), ...refused],
  );
  return { results, ...published };
}

/**
 * Starts the run the call's entry point names, or sends a call with `taskId`
 * to the running `serve` task it names.
 */
async function dispatchWorkflowCall(
  start: StartWorkflowTaskInput,
  admissionView: SessionView,
): Promise<{
  readonly result?: RuntimeActionResult;
  readonly session: HarnessSessionBase;
  readonly started?: TaskCallStart;
  readonly refusal?: "task-limit" | "task-unavailable";
}> {
  const { entry } = start.task;
  switch (entry.entryPoint) {
    case "execute":
      return await startWorkflowTask(start);
    case "task":
    case "serve":
      return await startTaskRun({ ...start, entry }, admissionView);
    case "receive":
      return await sendToTask({ ...start, taskId: entry.taskId }, admissionView);
  }
}
