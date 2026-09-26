import type { SessionAuth, SessionParent } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
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

/** Everything the session knows when it starts one workflow tool call's run. */
export interface StartWorkflowTaskInput {
  readonly agentContext: AgentSessionContext;
  readonly agents: WorkflowToolRunInput["agents"];
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
}

/** Starts the run for one call, which invokes the entry point the request names. */
export async function startWorkflowToolCallRun(
  input: StartWorkflowTaskInput,
): Promise<WorkflowToolRunAddress> {
  const { task, batchEvent, session } = input;
  return await startWorkflowToolRun({
    agentContext: input.agentContext,
    agents: input.agents,
    callId: task.callId,
    entry: task.entry,
    executeInput: task.executeInput,
    input: task.input,
    owner: input.owner,
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
}

/** Starts the run of a call the turn waits on and records it on the owning session. */
export async function startWorkflowTask(
  input: StartWorkflowTaskInput,
): Promise<{ readonly result?: RuntimeToolResultActionResult; readonly session: RuntimeSession }> {
  const { task, batchEvent, session } = input;
  try {
    const started = await startWorkflowToolCallRun(input);
    return {
      session: registerWorkflowToolRun(session, {
        callId: task.callId,
        origin: { turnId: batchEvent.turnId, stepIndex: batchEvent.stepIndex },
        address: started,
        toolName: task.toolName,
      }),
    };
  } catch (error) {
    logError(log, "workflow tool run failed to start", error, {
      callId: task.callId,
      toolName: task.toolName,
    });
    return { result: startFailureResult(task, error), session };
  }
}

/** The call's tool result when its run could not start. */
export function startFailureResult(
  task: RuntimeWorkflowTaskRequest,
  error: unknown,
): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: task.callId,
    isError: true,
    output: toError(error),
    toolName: task.toolName,
  });
}
