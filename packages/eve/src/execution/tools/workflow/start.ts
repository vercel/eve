import type { SessionAuth, SessionParent } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { LocalAgentSessions } from "#execution/agent-sessions/sessions-over.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createLogger, logError } from "#internal/logging.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolRunEntry,
} from "#shared/action-types.js";
import { toError } from "#shared/errors.js";
import type { DirectChildPublication } from "#harness/session-machine/transitions.js";
import type { TaskRunAddress } from "#execution/tasks/table.js";
import type {
  WorkflowToolRunAddress,
  WorkflowToolRunInput,
} from "#execution/tools/workflow/types.js";
import type { WorkflowToolRunOwner } from "#execution/tools/workflow/messages.js";

const log = createLogger("execution.workflow-tool-run");

export type StartWorkflowToolRun = (
  input: Omit<WorkflowToolRunInput, "hookToken">,
) => Promise<WorkflowToolRunAddress>;

export function workflowToolRunHookToken(input: Omit<WorkflowToolRunInput, "hookToken">): string {
  return input.entry.entryPoint === "execute"
    ? crypto.randomUUID()
    : taskRunHookToken(input.session.id, input.entry.taskId);
}

function taskRunHookToken(sessionId: string, taskId: string): string {
  return `eve:task:${sessionId}:${taskId}`;
}

export interface StartWorkflowTaskInput {
  readonly agentContext: AgentSessionContext;
  readonly auth: SessionAuth;
  readonly batchEvent: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly directAgents?: LocalAgentSessions;
  readonly owner: WorkflowToolRunOwner;
  readonly parentSession: SessionParent | undefined;
  readonly prestarted?: PrestartedWorkflowToolRun;
  readonly session: HarnessSessionBase;
  readonly startRun: StartWorkflowToolRun;
  readonly task: RuntimeWorkflowTaskRequest;
}

export interface PrestartedDirectAgent {
  readonly address: TaskRunAddress;
  readonly child: DirectChildPublication;
}

export interface PrestartedWorkflowToolRun {
  readonly direct?: Promise<PrestartedDirectAgent | undefined>;
  readonly entry: WorkflowToolRunEntry;
  readonly run?: Promise<WorkflowToolRunAddress>;
}

export async function startWorkflowToolCallRun(
  input: StartWorkflowTaskInput,
  entry: WorkflowToolRunEntry,
): Promise<WorkflowToolRunAddress> {
  const { prestarted } = input;
  if (prestarted?.run !== undefined) {
    if (!isSameRunEntry(prestarted.entry, entry)) {
      throw new Error(`Call "${input.task.callId}" was started for a different entry point.`);
    }
    return await prestarted.run;
  }
  const { task, batchEvent, session } = input;
  return await input.startRun({
    agentContext: input.agentContext,
    callId: task.callId,
    entry,
    executeInput: task.executeInput,
    input: task.input,
    owner: input.owner,
    session: {
      auth: input.auth,
      id: session.sessionId,
      parent: input.parentSession,
      turn: { id: batchEvent.turnId, sequence: batchEvent.sequence },
    },
    stepIndex: batchEvent.stepIndex,
    toolName: task.toolName,
    workflowId: task.workflowId,
  });
}

function isSameRunEntry(a: WorkflowToolRunEntry, b: WorkflowToolRunEntry): boolean {
  if (a.entryPoint === "execute" || b.entryPoint === "execute")
    return a.entryPoint === b.entryPoint;
  return a.entryPoint === b.entryPoint && a.taskId === b.taskId;
}

export async function startWorkflowTask(input: StartWorkflowTaskInput): Promise<{
  readonly result?: RuntimeToolResultActionResult;
  readonly session: HarnessSessionBase;
}> {
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
