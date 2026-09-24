import type { RuntimeActionResultHookPayload, TaskStartedHookPayload } from "#channel/types.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { hasPendingAgentTaskCalls } from "#tasks/agent-tool.js";
import {
  applyTaskReportStep,
  cancelTasksStep,
  startAgentTasksStep,
  type AgentTaskCall,
  type TaskOwnerUpdate,
} from "#tasks/owner.js";

// Owner-side helpers that run in the session workflow body. They only
// sequence steps, and must not import Node.js built-ins.

/** Adopts an owner step's state, publishes its events, and answers `ctx.agent` callers. */
export async function applyTaskOwnerUpdate(
  cursor: SessionStateCursor,
  update: TaskOwnerUpdate,
): Promise<readonly RuntimeToolResultActionResult[]> {
  await cursor.apply(update);
  for (const event of update.events) {
    await cursor.apply(
      await emitSubagentEventStep({
        event,
        sessionWritable: cursor.sessionWritable,
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      }),
    );
  }
  for (const reply of update.replies) {
    await resumeHookStep(
      reply.replyTo,
      { kind: "runtime-action-result", results: [reply.result] },
      { ifPresent: true },
    );
  }
  return update.results;
}

/** Starts the agent calls in the pending coordination batch and returns their immediate results. */
export async function startPendingAgentTasks(
  cursor: SessionStateCursor,
): Promise<readonly RuntimeToolResultActionResult[]> {
  if (!hasPendingAgentTaskCalls(cursor.sessionState.snapshot.session.state)) return [];
  return await applyTaskOwnerUpdate(
    cursor,
    await startAgentTasksStep({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

export async function startAgentTasks(
  cursor: SessionStateCursor,
  calls: readonly AgentTaskCall[],
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await startAgentTasksStep({
      calls,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/** Applies one child report and returns tool results for waited calls it settled. */
export async function applyTaskReport(
  cursor: SessionStateCursor,
  payload: RuntimeActionResultHookPayload | TaskStartedHookPayload,
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await applyTaskReportStep({
      payload,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/** Cancels the agent tasks and workflow tool runs the active turn is waiting on. */
export async function cancelTurnDescendants(cursor: SessionStateCursor): Promise<void> {
  await cursor.apply(
    await cancelTasksStep({
      selector: { kind: "active-turn" },
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
  await cancelDescendantTurnsStep({ sessionState: cursor.sessionState });
}
