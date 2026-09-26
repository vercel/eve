import type { SessionAuth, SessionParent } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolRunEntry,
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
  const hookToken =
    input.entry.entryPoint === "execute"
      ? crypto.randomUUID()
      : taskRunHookToken(input.session.id, input.entry.taskId);
  const run = await startWorkflowOnCurrentDeployment(workflowToolRunWorkflowReference, [
    { ...input, hookToken },
  ]);
  return { hookToken, runId: run.runId };
}

/**
 * A task's run takes the session's commands, including later calls to a
 * `serve` task, on a hook named for the task: at most one run can hold it, so
 * a retried start can never leave a second run taking the task's calls.
 */
function taskRunHookToken(sessionId: string, taskId: string): string {
  return `eve:task:${sessionId}:${taskId}`;
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
  readonly session: HarnessSession;
  readonly task: RuntimeWorkflowTaskRequest;
}

/** Starts the run for one call, which invokes `entry`. */
export async function startWorkflowToolCallRun(
  input: StartWorkflowTaskInput,
  entry: WorkflowToolRunEntry,
): Promise<WorkflowToolRunAddress> {
  const { task, batchEvent, session } = input;
  return await startWorkflowToolRun({
    agentContext: input.agentContext,
    agents: input.agents,
    callId: task.callId,
    entry,
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

/** Starts the run of an `execute` call the turn waits on and records it on the owning session. */
export async function startWorkflowTask(
  input: StartWorkflowTaskInput,
): Promise<{ readonly result?: RuntimeToolResultActionResult; readonly session: HarnessSession }> {
  const { task, batchEvent, session } = input;
  try {
    const started = await startWorkflowToolCallRun(input, { entryPoint: "execute" });
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
