import { observeToolOutput } from "#tool-stubs/execute.js";
import type { ModelMessage, SystemModelMessage } from "ai";

import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";
import {
  FINAL_REPLY_TASK_SYSTEM_BLOCK,
  renderModelOutputText,
  renderTaskResults,
  renderTasksNote,
  TASK_SYSTEM_BLOCK,
  TASKS_NOTE_LABEL,
  type ListedTask,
  type TaskResultBlock,
} from "#execution/tasks/render.js";
import {
  createTask,
  idleTasks,
  readTaskTable,
  takeTaskResults,
  workingTasks,
  writeTaskTable,
  type TaskRecord,
  type TaskResult,
} from "#execution/tasks/table.js";
import { splitTaskIdInput } from "#execution/tasks/task-id-input.js";
import { entryPointOf, isAgentTool } from "#execution/tasks/tool-entry-point.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ToolModelOutputContext } from "#tools/model-output.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, HarnessToolLookup, HarnessToolMap } from "#harness/types.js";
import type { WorkflowToolCallEntry } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import { taskCancelTool } from "#tools/provided/task-cancel.js";
import { taskWaitTool } from "#tools/provided/task-wait.js";

export function isTaskTool(definition: HarnessToolDefinition | undefined): boolean {
  return (
    definition?.frameworkAction === "task-wait" || definition?.frameworkAction === "task-cancel"
  );
}

export function isWorkflowTool(definition: HarnessToolDefinition | undefined): boolean {
  return definition?.workflowId !== undefined || isTaskTool(definition);
}

export function withTaskTools(tools: HarnessToolMap): HarnessToolMap {
  return new Map([
    ...tools,
    [TASK_WAIT_TOOL_NAME, taskWaitTool],
    [TASK_CANCEL_TOOL_NAME, taskCancelTool],
  ]);
}

export function taskSystemMessages(offers: boolean, finalReplyOnly: boolean): SystemModelMessage[] {
  if (!offers) return [];
  const content = finalReplyOnly ? FINAL_REPLY_TASK_SYSTEM_BLOCK : TASK_SYSTEM_BLOCK;
  return [{ content, role: "system" }];
}

export interface WorkflowCall {
  readonly callId: string;
  readonly definition: HarnessToolDefinition | undefined;
  readonly input: JsonObject;
  readonly toolName: string;
  readonly turnId: string;
}

export interface CommittedCallEntry {
  readonly entry: WorkflowToolCallEntry;
  readonly input: JsonObject;
  readonly session: HarnessSession;
}

export function commitCallEntry(session: HarnessSession, call: WorkflowCall): CommittedCallEntry {
  const entryPoint = entryPointOf(call.definition);
  switch (entryPoint) {
    case "execute":
      return { entry: { entryPoint }, input: call.input, session };
    case "task":
      return commitTask(session, call, entryPoint, call.input);
    case "serve": {
      const { input, taskId } = splitTaskIdInput(call.input);
      if (taskId === undefined) return commitTask(session, call, entryPoint, input);
      return { entry: { entryPoint: "receive", taskId }, input, session };
    }
  }
}

function commitTask(
  session: HarnessSession,
  call: WorkflowCall,
  entryPoint: "task" | "serve",
  input: JsonObject,
): CommittedCallEntry {
  const created = createTask(readTaskTable(session.state), {
    callId: call.callId,
    kind: isAgentTool(call.definition) ? "agent" : "tool",
    name: call.toolName,
    resumable: entryPoint === "serve",
    turnId: call.turnId,
  });
  return {
    entry: { entryPoint, taskId: created.taskId },
    input,
    session: writeTaskTable(session, created.table),
  };
}

export function workingTaskIds(session: HarnessSession): readonly string[] {
  return workingTasks(readTaskTable(session.state)).map((record) => record.id);
}

export type ToolModelOutputContextFactory = (
  toolName: string,
  callId: string,
) => ToolModelOutputContext;

export async function appendTaskContext(input: {
  readonly messages: readonly HarnessModelMessage[];
  readonly outputContext: ToolModelOutputContextFactory;
  readonly session: HarnessSession;
  readonly tools: HarnessToolLookup;
}): Promise<{
  readonly messages: readonly HarnessModelMessage[];
  readonly session: HarnessSession;
}> {
  const appended: HarnessModelMessage[] = [];
  const delivery = await deliverTaskResults(input);
  if (delivery.message !== undefined) {
    appended.push(createFrameworkUserMessage("task.result", delivery.message));
  }
  const note = resolveTasksNote({
    messages: [...input.messages, ...appended],
    session: delivery.session,
  });
  if (note !== undefined) appended.push(createFrameworkUserMessage("context.state", note));
  return { messages: appended, session: delivery.session };
}

async function deliverTaskResults(input: {
  readonly outputContext: ToolModelOutputContextFactory;
  readonly session: HarnessSession;
  readonly tools: HarnessToolLookup;
}): Promise<{ readonly message?: string; readonly session: HarnessSession }> {
  const { table, taken } = takeTaskResults(readTaskTable(input.session.state));
  if (taken.length === 0) return { session: input.session };
  const blocks: TaskResultBlock[] = [];
  for (const record of taken) {
    for (const result of record.results) {
      blocks.push(
        await toResultBlock(record, result, input.tools.get(record.name), input.outputContext),
      );
    }
  }
  return { message: renderTaskResults(blocks), session: writeTaskTable(input.session, table) };
}

async function toResultBlock(
  record: TaskRecord,
  result: TaskResult,
  definition: HarnessToolDefinition | undefined,
  outputContext: ToolModelOutputContextFactory,
): Promise<TaskResultBlock> {
  const base = { taskId: record.id, tool: record.name };
  if (result.status === "failed") return { ...base, body: result.error, status: "failed" };
  return {
    ...base,
    body: await projectOutput(record, result, definition, outputContext),
    status: "completed",
  };
}

async function projectOutput(
  { id: taskId, name: tool }: TaskRecord,
  result: Extract<TaskResult, { status: "completed" }>,
  definition: HarnessToolDefinition | undefined,
  outputContext: ToolModelOutputContextFactory,
): Promise<string> {
  if (definition?.toModelOutput === undefined) return renderModelOutputText(result.output);
  return await observeToolOutput(
    tool,
    result.calls ?? [],
    async () =>
      renderModelOutputText(
        await definition.toModelOutput!(result.output, outputContext(tool, taskId)),
      ),
    () => renderModelOutputText(result.output),
  );
}

function resolveTasksNote(input: {
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): string | undefined {
  const table = readTaskTable(input.session.state);
  const working = workingTasks(table).map(toListedTask);
  const idle = idleTasks(table).map(toListedTask);
  const latest = input.messages.findLast(isTasksNote);
  if (latest === undefined && working.length === 0 && idle.length === 0) return undefined;
  const rendered = renderTasksNote({ idle, working });
  return latest?.content === rendered ? undefined : rendered;
}

function toListedTask(record: TaskRecord): ListedTask {
  return { id: record.id, tool: record.name };
}

function isTasksNote(message: ModelMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(TASKS_NOTE_LABEL)
  );
}
