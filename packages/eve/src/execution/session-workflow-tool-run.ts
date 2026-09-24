import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import { emitWorkflowToolRunReportStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  cancelTasks,
  settleWorkflowTask,
  startAgentTasks,
  surfaceTaskInput,
} from "#tasks/owner-body.js";
import { isTerminalTaskStatus } from "#tasks/protocol.js";
import { findWorkflowTask, getTaskTable } from "#tasks/state.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { dismissStaleWorkflowRequestStep } from "#execution/tools/workflow/stale-request-step.js";
import { workflowAskInputEvent } from "#execution/tools/workflow/owner-inbox.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

interface HandlerInput<T> {
  readonly cursor: SessionStateCursor;
  readonly message: T;
}

export async function handleWorkflowToolRunMessage(
  input: HandlerInput<WorkflowToolRunMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { message } = input;
  switch (message.kind) {
    case "outcome":
      return await handleWorkflowToolRunOutcome({ ...input, message });
    case "request":
      await handleWorkflowToolRunRequest({ ...input, message });
      return undefined;
    case "report":
      await emitWorkflowToolRunReportStep({
        from: message.from,
        sessionWritable: input.cursor.sessionWritable,
        update: message.update,
      });
      return undefined;
  }
}

/**
 * Settles the workflow task a run's outcome reports and returns the tool
 * result the waiting turn accepts, or `undefined` when the outcome settles
 * no working task.
 */
async function handleWorkflowToolRunOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<RuntimeActionResult | undefined> {
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
  const [result] = await settleWorkflowTask(cursor, message);
  return result;
}

async function handleWorkflowToolRunRequest(
  input: HandlerInput<WorkflowToolRunRequestMessage>,
): Promise<void> {
  const { cursor, message } = input;
  const task = findWorkflowTask(getTaskTable(cursor.sessionState.snapshot.session), message.from);
  // A cancelled or orphaned run keeps running until it unwinds; nothing it
  // asks for reaches the user or starts more work.
  const taskId = task !== undefined && !isTerminalTaskStatus(task.status) ? task.id : undefined;
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
            output: {
              code: "AGENT_INVOCATION_NOT_ADMITTED",
              message: "The workflow tool run no longer owns this agent invocation.",
            },
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
  await surfaceTaskInput(
    cursor,
    taskId,
    workflowAskInputEvent({ ...message, request: message.request }),
  );
}
