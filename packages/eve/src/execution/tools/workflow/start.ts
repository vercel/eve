import type { SessionAuth, SessionParent } from "#context/session-context.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { recordWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeSession } from "#subagents/handle-dispatch.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { toError } from "#shared/errors.js";
import type {
  WorkflowToolRunAddress,
  WorkflowToolRunInput,
} from "#execution/tools/workflow/types.js";
import type { WorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";
import {
  startWorkflowOnCurrentDeployment,
  workflowToolRunWorkflowReference,
} from "#execution/workflow-runtime.js";

const log = createLogger("execution.workflow-tool-run");

/** Starts a new run for each dispatch attempt. Call from a `"use step"` body. */
export async function startWorkflowToolRun(
  input: Omit<WorkflowToolRunInput, "hookToken">,
): Promise<WorkflowToolRunAddress> {
  const hookToken = crypto.randomUUID();
  const run = await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [
    { ...input, hookToken },
  ]);
  return { hookToken, runId: run.runId };
}

/** Starts one durable workflow task and records it on the owning session. */
export async function startWorkflowTask(input: {
  readonly auth: SessionAuth["current"];
  readonly batchEvent: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly initiatorAuth: SessionAuth["initiator"];
  readonly owner: WorkflowToolRunOwner;
  readonly parentSession: SessionParent | undefined;
  readonly session: RuntimeSession;
  readonly task: RuntimeWorkflowTaskRequest;
}): Promise<{ readonly result?: RuntimeToolResultActionResult; readonly session: RuntimeSession }> {
  const { task, batchEvent, session } = input;
  try {
    const started = await startWorkflowToolRun({
      callId: task.callId,
      executeInput: task.executeInput,
      input: task.input,
      owner: input.owner,
      resultKind: task.resultKind,
      session: {
        auth: { current: input.auth, initiator: input.initiatorAuth },
        id: session.sessionId,
        parent: input.parentSession,
        turn: { id: batchEvent.turnId, sequence: batchEvent.sequence },
      },
      stepIndex: batchEvent.stepIndex,
      toolName: task.toolName,
      workflowId: task.workflowId,
    });
    return {
      session: recordWorkflowToolRun(session, {
        callId: task.callId,
        hookToken: started.hookToken,
        resultKind: task.resultKind ?? "tool",
        runId: started.runId,
        toolName: task.toolName,
      }),
    };
  } catch (error) {
    logError(log, "workflow tool run failed to start", error, {
      callId: task.callId,
      toolName: task.toolName,
    });
    return {
      result: createRuntimeToolResultFromValue({
        callId: task.callId,
        isError: true,
        output: toError(error),
        toolName: task.toolName,
      }),
      session,
    };
  }
}
