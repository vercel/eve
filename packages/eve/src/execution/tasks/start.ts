import { SessionStrandedError } from "#channel/session-stranded-error.js";
import { currentStepAttempt } from "#execution/hosts.js";
import { normalizeAgentMessage } from "#execution/agent-sessions/message.js";
import {
  agentSessionResetCommand,
  localAgentSendCommand,
  prepareLocalAgentSession,
  resolveAgentSessionStart,
} from "#execution/agent-sessions/start.js";
import { toErrorMessage } from "#shared/errors.js";
import { NonRetryableError } from "#shared/run-errors.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import {
  renderTaskReceipt,
  renderTaskSentReceipt,
  renderTooManyTasksError,
  renderUnknownTaskError,
} from "#execution/tasks/render.js";
import { sendTaskRunCommands } from "#execution/tasks/steps.js";
import {
  findTask,
  finishTaskRun,
  isTaskAvailable,
  MAX_WORKING_TASKS,
  readTaskTable,
  recordTaskCall,
  recordTaskRun,
  redirectDirectTaskRun,
  removeTask,
  settleRemainingTaskCalls,
  writeTaskTable,
  type TaskRecord,
  type TaskRunAddress,
  type TaskTable,
} from "#execution/tasks/table.js";
import {
  startFailureResult,
  startWorkflowToolCallRun,
  type StartWorkflowTaskInput,
} from "#execution/tools/workflow/start.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createLogger, logError } from "#internal/logging.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type {
  DirectChildPublication,
  DirectTaskFailure,
  TaskCallStart,
} from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { createEveSessionStreamRoutePath } from "#protocol/routes.js";
import { isWorking, tasks } from "#protocol/session-projection/selectors.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { TOO_MANY_TASKS_CODE, UNKNOWN_TASK_CODE } from "#protocol/task-tools.js";
import { agentModelsServeWorkflow } from "#runtime/subagents/workflow.js";
import { agentToolServeWorkflowReference } from "#runtime/subagents/workflow-reference.js";
import type {
  RuntimeToolResultActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolRunEntry,
} from "#shared/action-types.js";
import type { MessageContent } from "#shared/message-content.js";
import { readWorkflowFunctionId } from "#shared/workflow-function-id.js";
import { findStubTarget } from "#tool-stubs/target.js";
import { agentDelegation } from "#tracing/eve/delegation.js";

const log = createLogger("execution.tasks");

type TaskDispatchInput = StartWorkflowTaskInput & { readonly taskId: string };

interface TaskDispatchResult {
  readonly child?: DirectChildPublication;
  readonly failedTask?: DirectTaskFailure;
  readonly result: RuntimeToolResultActionResult;
  readonly session: HarnessSessionBase;
  readonly started?: TaskCallStart;
  readonly refusal?: "task-limit" | "task-unavailable";
}

type TaskRunEntry = Extract<WorkflowToolRunEntry, { readonly taskId: string }>;

const FALLBACK_AGENT_MODELS_SERVE_WORKFLOW_ID = `workflow//${EVE_PACKAGE_NAME}//agentModelsServeWorkflow`;

const AGENT_MODEL_CHANGE_ERROR =
  "An agent task keeps the model it started with. This task has ended; start a new task to use another model.";

function isAgentModelsWorkflowId(workflowId: string): boolean {
  const modelsId =
    readWorkflowFunctionId(agentModelsServeWorkflow) ?? FALLBACK_AGENT_MODELS_SERVE_WORKFLOW_ID;
  return workflowId === modelsId;
}

export function isDirectLocalAgentCandidate(input: StartWorkflowTaskInput): boolean {
  return (
    input.directAgents !== undefined &&
    (input.task.workflowId === agentToolServeWorkflowReference.workflowId ||
      isAgentModelsWorkflowId(input.task.workflowId)) &&
    findStubTarget(input.agentContext.toolStubs, input.task.toolName) === undefined
  );
}

function readAgentMessageInput(input: StartWorkflowTaskInput): MessageContent<string | URL> {
  const payload = (input.task.executeInput ?? input.task.input) as { readonly message?: unknown };
  return normalizeAgentMessage(payload.message as MessageContent<string | URL>);
}

function readAgentModelInput(input: StartWorkflowTaskInput): string | undefined {
  const payload = (input.task.executeInput ?? input.task.input) as { readonly model?: unknown };
  return typeof payload.model === "string" ? payload.model : undefined;
}

export async function tryStartDirectLocalAgent(
  input: TaskDispatchInput,
): Promise<
  { readonly address: TaskRunAddress; readonly child: DirectChildPublication } | undefined
> {
  const local = input.directAgents;
  if (local === undefined || !isDirectLocalAgentCandidate(input)) return undefined;
  const isModelsTool = isAgentModelsWorkflowId(input.task.workflowId);
  const model = isModelsTool ? readAgentModelInput(input) : undefined;
  const message = readAgentMessageInput(input);
  const key = `${input.session.sessionId}:${input.taskId}`;
  const start = await resolveAgentSessionStart({
    auth: input.auth,
    context: input.agentContext,
    key,
    message,
    ...(model !== undefined && { model }),
    name: isModelsTool ? "agent" : input.task.toolName,
    replyTo: input.owner.inbox,
    toolName: input.task.toolName,
  });
  if (start.target.kind !== "local") return undefined;
  const prepared = prepareLocalAgentSession({
    ...start,
    directTask: {
      sequence: input.batchEvent.sequence,
      stepIndex: input.batchEvent.stepIndex,
      taskId: input.taskId,
      toolName: input.task.toolName,
      turnId: input.batchEvent.turnId,
    },
    target: start.target,
  });
  const started = await agentDelegation.resume(
    { context: input.agentContext, agentName: start.agentName },
    () => local.start(prepared, start),
  );
  const childSessionId = started.address.sessionId;
  return {
    address: {
      directAgent: {
        continuationToken: prepared.childContinuationToken,
        ...(isModelsTool && {
          isModelsTool: true,
          ...(model !== undefined && { model }),
        }),
        name: start.target.action.name,
        nodeId: start.target.action.nodeId,
      },
      hookToken: sessionInboxHookToken(sessionCommandHookToken(childSessionId)),
      runId: childSessionId,
    },
    child: {
      callId: input.task.callId,
      ...(started.deliveryId !== undefined && { childDeliveryId: started.deliveryId }),
      name: start.target.action.name,
      sessionId: childSessionId,
      stream: createEveSessionStreamRoutePath(childSessionId),
      taskId: input.taskId,
      turnId: input.batchEvent.turnId,
    },
  };
}

export async function startTaskRun(
  input: StartWorkflowTaskInput & { readonly entry: TaskRunEntry },
  admissionView = storedProjection(input.session.state).view,
): Promise<TaskDispatchResult> {
  const { entry, session, task } = input;
  const { taskId } = entry;
  const dispatch = { ...input, taskId };
  const receipt = startReceipt(dispatch, entry.entryPoint === "serve");
  const table = readTaskTable(session.state);
  const record = findTask(table, taskId);
  if (admissionView.calls[task.callId]?.status === "settled") return { result: receipt, session };
  if (record === undefined)
    return {
      result: startFailureResult(task, new Error(`Task dispatch record ${taskId} is unavailable.`)),
      session,
    };

  const overCap = tooManyTasks(dispatch, admissionView);
  if (overCap !== undefined) {
    return {
      result: overCap,
      refusal: "task-limit",
      session: writeTaskTable(session, removeTask(table, taskId)),
    };
  }

  let address: TaskRunAddress;
  let child: DirectChildPublication | undefined;
  try {
    const direct =
      input.prestarted?.direct !== undefined
        ? await input.prestarted.direct
        : await tryStartDirectLocalAgent(dispatch);
    if (direct !== undefined) {
      address = direct.address;
      child = direct.child;
    } else {
      address = await startWorkflowToolCallRun(input, entry);
    }
  } catch (error) {
    logError(log, "task run failed to start", error, { taskId, toolName: task.toolName });
    return {
      result: startFailureResult(task, error),
      session: writeTaskTable(session, removeTask(table, taskId)),
    };
  }

  return {
    ...(child !== undefined && { child }),
    result: receipt,
    session: writeTaskTable(session, recordTaskRun(table, taskId, address)),
    started: taskCallStart(dispatch, record),
  };
}

const DEFAULT_DIRECT_SEND_MAX_ATTEMPTS = 4;

function isPermanentDirectSendError(error: unknown): boolean {
  return SessionStrandedError.is(error) || error instanceof NonRetryableError;
}

export async function sendToTask(
  input: TaskDispatchInput,
  admissionView = storedProjection(input.session.state).view,
): Promise<TaskDispatchResult> {
  const { session, task, taskId } = input;
  const table = readTaskTable(session.state);
  const record = findTask(table, taskId);
  if (
    admissionView.tasks[taskId]?.status !== "running" ||
    !isTaskAvailable(record, task.toolName)
  ) {
    return { result: unknownTaskResult(input), refusal: "task-unavailable", session };
  }

  if (!isWorking(admissionView, taskId)) {
    const overCap = tooManyTasks(input, admissionView);
    if (overCap !== undefined) return { result: overCap, refusal: "task-limit", session };
  }

  const directAgent = record.run.directAgent;
  if (directAgent !== undefined && input.directAgents !== undefined) {
    const recorded = recordTaskCall(table, taskId, {
      agentContext: input.agentContext,
      auth: input.auth,
      callId: task.callId,
      executeInput: task.executeInput,
      input: task.input,
      sequence: input.batchEvent.sequence,
      stepIndex: input.batchEvent.stepIndex,
      turnId: input.batchEvent.turnId,
    });
    const deliveryId = `direct-agent:${session.sessionId}:${taskId}:${task.callId}:send`;
    const localAddress = {
      continuationToken: directAgent.continuationToken,
      kind: "local" as const,
      name: directAgent.name,
      nodeId: directAgent.nodeId,
      sessionId: record.run.runId,
    };
    let message: MessageContent<string | URL> | undefined;
    let sendFailure: string | undefined;
    if (directAgent.isModelsTool) {
      const requestedModel = readAgentModelInput(input);
      if (requestedModel !== undefined && requestedModel !== directAgent.model) {
        sendFailure = AGENT_MODEL_CHANGE_ERROR;
      }
    }
    if (sendFailure === undefined) {
      try {
        message = readAgentMessageInput(input);
      } catch (error) {
        sendFailure = toErrorMessage(error);
      }
    }
    let acceptedSessionId: string | undefined;
    if (sendFailure === undefined && message !== undefined) {
      const command = localAgentSendCommand(
        {
          address: localAddress,
          auth: input.auth,
          context: input.agentContext,
          directTask: {
            sequence: input.batchEvent.sequence,
            stepIndex: input.batchEvent.stepIndex,
            taskId,
            toolName: task.toolName,
            turnId: input.batchEvent.turnId,
          },
          key: `${session.sessionId}:${taskId}`,
          message,
          replyTo: input.owner.inbox,
        },
        deliveryId,
      );
      const maxAttempts = input.directSendMaxAttempts ?? DEFAULT_DIRECT_SEND_MAX_ATTEMPTS;
      try {
        const sent = await input.directAgents.command(
          {
            address: localAddress,
            context: input.agentContext,
            key: `${session.sessionId}:${taskId}`,
          },
          command,
        );
        if (sent.status === "accepted") {
          acceptedSessionId = sent.sessionId;
        } else {
          sendFailure = `Agent "${directAgent.name}" can no longer receive messages; its session ended.`;
        }
      } catch (error) {
        if (
          !isPermanentDirectSendError(error) &&
          (currentStepAttempt() ?? maxAttempts) < maxAttempts
        ) {
          throw error;
        }
        sendFailure = SessionStrandedError.is(error)
          ? `Agent "${directAgent.name}" can no longer receive messages: ${error.message}`
          : toErrorMessage(error);
      }
    }
    if (sendFailure !== undefined || acceptedSessionId === undefined) {
      const error =
        sendFailure ??
        `Agent "${directAgent.name}" can no longer receive messages; its session ended.`;
      await input.directAgents
        .commandLate(
          record.run.runId,
          agentSessionResetCommand(
            `direct-agent:${session.sessionId}:${taskId}:${task.callId}:reset`,
          ),
        )
        .catch(() => undefined);
      const settled = settleRemainingTaskCalls(recorded.table, taskId, { error, status: "failed" });
      const finished = finishTaskRun(settled.table, taskId, record.run.runId);
      return {
        failedTask: {
          error,
          settledCallIds: settled.settled
            .map((call) => call.callId)
            .filter((callId) => callId !== task.callId),
          taskId,
          turnId: input.batchEvent.turnId,
        },
        result: startFailureResult(task, new Error(error)),
        session: writeTaskTable(session, finished),
      };
    }
    const redirected =
      acceptedSessionId === record.run.runId
        ? recorded.table
        : redirectDirectTaskRun(
            recorded.table,
            taskId,
            acceptedSessionId,
            sessionInboxHookToken(sessionCommandHookToken(acceptedSessionId)),
          );
    const child: DirectChildPublication = {
      callId: task.callId,
      childDeliveryId: deliveryId,
      ...(acceptedSessionId !== record.run.runId && {
        name: directAgent.name,
        stream: createEveSessionStreamRoutePath(acceptedSessionId),
      }),
      sessionId: acceptedSessionId,
      taskId,
      turnId: input.batchEvent.turnId,
    };
    return {
      child,
      result: toolResult(input, renderTaskSentReceipt(taskId)),
      session: writeTaskTable(session, redirected),
      started: taskCallStart(input, record),
    };
  }

  const recorded = recordTaskCall(table, taskId, {
    agentContext: input.agentContext,
    auth: input.auth,
    callId: task.callId,
    executeInput: task.executeInput,
    input: task.input,
    sequence: input.batchEvent.sequence,
    stepIndex: input.batchEvent.stepIndex,
    turnId: input.batchEvent.turnId,
  });
  if (recorded.send !== undefined) await sendTaskRunCommands(recorded.send);
  return {
    result: toolResult(input, renderTaskSentReceipt(taskId)),
    session: writeTaskTable(session, recorded.table),
    started: taskCallStart(input, record),
  };
}

export function runEntryToStart(
  table: TaskTable,
  view: SessionView,
  task: RuntimeWorkflowTaskRequest,
): WorkflowToolRunEntry | undefined {
  const { entry } = task;
  switch (entry.entryPoint) {
    case "execute":
      return { entryPoint: "execute" };
    case "task":
    case "serve":
      return findTask(table, entry.taskId) === undefined ||
        view.calls[task.callId]?.status === "settled"
        ? undefined
        : entry;
    case "receive":
      return undefined;
  }
}

export function startsEveryRun(
  table: TaskTable,
  view: SessionView,
  tasks: readonly RuntimeWorkflowTaskRequest[],
): boolean {
  if (tasks.some((task) => task.entry.entryPoint === "receive")) return false;
  const starting = tasks.filter(
    (task) =>
      task.entry.entryPoint !== "execute" && runEntryToStart(table, view, task) !== undefined,
  );
  return workingTasks(view).length + starting.length <= MAX_WORKING_TASKS;
}

function workingTasks(view: SessionView) {
  return tasks(view, { status: "working" });
}

function tooManyTasks(
  input: TaskDispatchInput,
  view: SessionView,
): RuntimeToolResultActionResult | undefined {
  const running = workingTasks(view);
  if (running.length < MAX_WORKING_TASKS) return undefined;
  const runningIds = running.map((candidate) => candidate.taskId);
  return createRuntimeToolResultFromValue({
    callId: input.task.callId,
    isError: true,
    output: {
      code: TOO_MANY_TASKS_CODE,
      message: renderTooManyTasksError(MAX_WORKING_TASKS, runningIds),
    },
    toolName: input.task.toolName,
  });
}

function unknownTaskResult(input: TaskDispatchInput): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: input.task.callId,
    isError: true,
    output: {
      code: UNKNOWN_TASK_CODE,
      message: renderUnknownTaskError(input.taskId, input.task.toolName),
    },
    toolName: input.task.toolName,
  });
}

function taskCallStart(input: TaskDispatchInput, record: TaskRecord): TaskCallStart {
  return {
    callId: input.task.callId,
    clearedBy: input.task.clearedBy,
    kind: record.kind,
    name: input.task.toolName,
    taskId: input.taskId,
    turnId: input.batchEvent.turnId,
  };
}

function startReceipt(input: TaskDispatchInput, resumable: boolean): RuntimeToolResultActionResult {
  const receipt = renderTaskReceipt({ id: input.taskId, resumable, tool: input.task.toolName });
  return toolResult(input, receipt);
}

function toolResult(input: TaskDispatchInput, output: string): RuntimeToolResultActionResult {
  return createRuntimeToolResultFromValue({
    callId: input.task.callId,
    output,
    toolName: input.task.toolName,
  });
}
