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
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { deriveWorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";
import {
  startWorkflowOnCurrentDeployment,
  workflowToolRunWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";

const log = createLogger("execution.workflow-tool-run");

// Derived from the call alone so a replayed dispatch starts a duplicate that
// loses the claim and still resolves to the workflow tool run that owns the call.
export function deriveWorkflowToolRunHookToken(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return `eve:workflow-tool-run:${deriveAgentOperationId(input)}`;
}

/** Resolves once the workflow tool run owns its hook. Call from a `"use step"` body. */
export async function startWorkflowToolRun(
  input: Omit<WorkflowToolRunInput, "hookToken"> & { readonly hookToken?: string },
): Promise<{ readonly hookToken: string; readonly runId: string }> {
  const hookToken =
    input.hookToken ??
    deriveWorkflowToolRunHookToken({
      callId: input.callId,
      parentSessionId: input.session.id,
      parentTurnId: input.session.turn.id,
    });
  const workflowToolRunInput = { ...input, hookToken } as WorkflowToolRunInput;
  await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [workflowToolRunInput]);
  const owner = await waitForCommandHookOwner(hookToken);
  return { hookToken, runId: owner.runId };
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
  readonly parentContinuationToken: string;
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
      owner: deriveWorkflowToolRunOwner(input.parentContinuationToken),
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
