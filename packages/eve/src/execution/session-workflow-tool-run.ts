import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import { emitWorkflowToolRunReportStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  applyWorkflowGeneration,
  cancelTasks,
  settleWorkflowTask,
  startAgentTasks,
  surfaceTaskInput,
} from "#tasks/owner-body.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { WORKFLOW_CALL_NOT_WORKING_MESSAGE } from "#tasks/render.js";
import { findWorkflowTask, getTaskTable } from "#tasks/state.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { dismissStaleWorkflowRequestStep } from "#execution/tools/workflow/stale-request-step.js";
import { workflowAskInputEvent } from "#execution/tools/workflow/owner-inbox.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

interface HandlerInput<T> {
  readonly cursor: SessionStateCursor;
  readonly message: T;
}

/**
 * Applies one message from a workflow tool run and returns the tool results
 * the turn accepts: an attached call's result, or a `task_wait`'s.
 */
export async function handleWorkflowToolRunMessage(
  input: HandlerInput<WorkflowToolRunMessage>,
): Promise<readonly RuntimeActionResult[]> {
  const { message } = input;
  switch (message.kind) {
    case "outcome":
      return await handleWorkflowToolRunOutcome({ ...input, message });
    case "started":
    case "reply":
    case "ended":
      return await applyWorkflowGeneration(input.cursor, message);
    case "request":
      await handleWorkflowToolRunRequest({ ...input, message });
      return [];
    case "report":
      await emitWorkflowToolRunReportStep({
        from: message.from,
        sessionWritable: input.cursor.sessionWritable,
        update: message.update,
      });
      return [];
  }
}

/**
 * Settles the workflow task a run's outcome reports and returns the tool
 * result the waiting turn accepts, if the outcome settles a working task.
 */
async function handleWorkflowToolRunOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<readonly RuntimeActionResult[]> {
  const { cursor, message } = input;
  // A workflow run that ends cancels the agent tasks it still owns, even
  // when the owner no longer waits on the run. Usually its calls all
  // settled already, and then there is nothing to cancel.
  const { runId } = message.from;
  if (
    getTaskTable(cursor.sessionState.snapshot.session).records.some(
      (record) => record.workflowCaller?.runId === runId && !isTerminalTaskStatus(record.status),
    )
  ) {
    await cancelTasks(cursor, { kind: "workflow-run", runId });
  }
  return await settleWorkflowTask(cursor, message);
}

async function handleWorkflowToolRunRequest(
  input: HandlerInput<WorkflowToolRunRequestMessage>,
): Promise<void> {
  const { cursor, message } = input;
  const task = findWorkflowTask(getTaskTable(cursor.sessionState.snapshot.session), message.from);
  // A cancelled or orphaned run keeps running until it unwinds, and a
  // resumable run's generation that replied owns no more work: nothing
  // either asks for reaches the user or starts more work.
  const taskId =
    task !== undefined &&
    task.generation === message.from.generation &&
    !isTerminalTaskStatus(task.status)
      ? task.id
      : undefined;
  if (message.request.kind === "agent-cancel") {
    await cancelTasks(cursor, {
      callId: message.request.invocationId,
      kind: "agent-call",
      runId: message.from.runId,
    });
    return;
  }
  if (message.request.kind === "agent-invoke") {
    if (taskId === undefined) {
      await resumeHookStep(message.replyTo, {
        kind: "runtime-action-result",
        results: [
          {
            callId: message.request.invocationId,
            isError: true,
            kind: "subagent-result",
            origin: "dispatch",
            output: { code: "TASK_NOT_WORKING", message: WORKFLOW_CALL_NOT_WORKING_MESSAGE },
            subagentName: message.request.input.target,
          },
        ],
      });
      return;
    }
    // The session owns the task because it holds the auth, capabilities, and
    // sandbox the child needs; the result goes to the body's reply hook.
    await startAgentTasks(cursor, [
      {
        callId: message.request.invocationId,
        input: message.request.input,
        workflowCaller: { replyTo: message.replyTo, runId: message.from.runId },
      },
    ]);
    return;
  }
  if (message.request.kind === "authorization-request") {
    const request = message.request;
    await deliverWorkflowAuthorization({ ...message, request }, async () => {
      if (taskId === undefined) await dismissStaleWorkflowRequestStep(message);
      else await surfaceTaskInput(cursor, taskId, request.event);
    });
    return;
  }
  if (taskId === undefined) {
    await dismissStaleWorkflowRequestStep(message);
    return;
  }
  // Surfaced like a child's question; the owner resolves it when it answers.
  const refused = await surfaceTaskInput(
    cursor,
    taskId,
    workflowAskInputEvent({ ...message, request: message.request }),
  );
  // No one can answer an ask whose ID is taken; dismissed, the run moves on.
  if (refused.length > 0) await dismissStaleWorkflowRequestStep(message);
}
