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
  type PersonWait,
  type TaskResultBlock,
} from "#execution/tasks/render.js";
import { suspendedSteps } from "#harness/session-machine/view.js";
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
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { HarnessSession, HarnessToolLookup, HarnessToolMap } from "#harness/types.js";
import type { WorkflowToolCallEntry } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import { taskCancelTool } from "#tools/provided/task-cancel.js";
import { taskWaitTool } from "#tools/provided/task-wait.js";

// What the model step does for tasks: it offers the task tools, commits a
// record for each call that starts a task, delivers settled results, keeps the
// `[Tasks]` note current, and tells the turn rule which tasks still work.

export function isTaskTool(definition: HarnessToolDefinition | undefined): boolean {
  return (
    definition?.frameworkAction === "task-wait" || definition?.frameworkAction === "task-cancel"
  );
}

/** Workflow tools, and the task tools that control them, run after the model step. */
export function isWorkflowTool(definition: HarnessToolDefinition | undefined): boolean {
  return definition?.workflowId !== undefined || isTaskTool(definition);
}

/** Adds `eve__task_wait` and `eve__task_cancel` to the tools of a session that offers tasks. */
export function withTaskTools(tools: HarnessToolMap): HarnessToolMap {
  return new Map([
    ...tools,
    [TASK_WAIT_TOOL_NAME, taskWaitTool],
    [TASK_CANCEL_TOOL_NAME, taskCancelTool],
  ]);
}

/**
 * The task block, when the session offers tasks. `finalReplyOnly` is set for a child or schedule
 * session, whose caller reads only the final reply, so a reply before a result reaches no one.
 */
export function taskSystemMessages(offers: boolean, finalReplyOnly: boolean): SystemModelMessage[] {
  if (!offers) return [];
  const content = finalReplyOnly ? FINAL_REPLY_TASK_SYSTEM_BLOCK : TASK_SYSTEM_BLOCK;
  return [{ content, role: "system" }];
}

/** A workflow tool call as the model made it, before the session knows what it enters. */
export interface WorkflowCall {
  readonly callId: string;
  readonly definition: HarnessToolDefinition | undefined;
  /** The call's model input. */
  readonly input: JsonObject;
  readonly toolName: string;
  readonly turnId: string;
}

/** How a workflow tool call enters its workflow, with the tool's own input. */
export interface CommittedCallEntry {
  readonly entry: WorkflowToolCallEntry;
  readonly input: JsonObject;
  readonly session: HarnessSession;
}

/**
 * How a workflow tool call enters its workflow. A call that starts a task commits
 * the task's record alongside the call, so the run starts with its id; a
 * `serve` tool's call with `taskId` goes to that task's `receive()`, which the
 * session checks when it sends the call.
 */
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

/**
 * The messages a model step appends for tasks, before any new input: one
 * `task.result` message with every settled result, then the
 * `[Tasks]` note when the listing changed. The results are marked delivered
 * in the same step. The message lives only in the model's history: clients
 * read outcomes from `call.settled`.
 */
export async function appendTaskContext(input: {
  readonly messages: readonly HarnessModelMessage[];
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

/**
 * Takes every settled result for one `task.result` message and
 * marks them delivered in the same step that appends the message.
 */
async function deliverTaskResults(input: {
  readonly session: HarnessSession;
  readonly tools: HarnessToolLookup;
}): Promise<{ readonly message?: string; readonly session: HarnessSession }> {
  const { table, taken } = takeTaskResults(readTaskTable(input.session.state));
  if (taken.length === 0) return { session: input.session };
  const blocks: TaskResultBlock[] = [];
  for (const record of taken) {
    for (const result of record.results) {
      blocks.push(await toResultBlock(record, result, input.tools.get(record.name)));
    }
  }
  return { message: renderTaskResults(blocks), session: writeTaskTable(input.session, table) };
}

async function toResultBlock(
  record: TaskRecord,
  result: TaskResult,
  definition: HarnessToolDefinition | undefined,
): Promise<TaskResultBlock> {
  const base = { taskId: record.id, tool: record.name };
  if (result.status === "failed") return { ...base, body: result.error, status: "failed" };
  return {
    ...base,
    // A call that waited on a person ran in the session, which shaped its output then.
    body:
      record.awaitsPerson === true
        ? renderModelOutputText(result.output)
        : await projectOutput(record.name, result, definition),
    status: "completed",
  };
}

async function projectOutput(
  tool: string,
  result: Extract<TaskResult, { status: "completed" }>,
  definition: HarnessToolDefinition | undefined,
): Promise<string> {
  if (definition?.toModelOutput === undefined) return renderModelOutputText(result.output);
  return await observeToolOutput(
    tool,
    result.calls ?? [],
    async () => renderModelOutputText(await definition.toModelOutput!(result.output)),
    // A projection that throws must not wedge every later model step.
    () => renderModelOutputText(result.output),
  );
}

/**
 * The `[Tasks]` note to append when the listing differs from the
 * latest one in history. Compaction drops old notes, so the listing returns.
 */
function resolveTasksNote(input: {
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): string | undefined {
  const table = readTaskTable(input.session.state);
  const awaiting = personWaits(input.session);
  const working = workingTasks(table).map((record) => ({
    ...toListedTask(record),
    ...(awaiting.has(record.id) && { awaiting: awaiting.get(record.id) }),
  }));
  const idle = idleTasks(table).map(toListedTask);
  const latest = input.messages.findLast(isTasksNote);
  if (latest === undefined && working.length === 0 && idle.length === 0) return undefined;
  const rendered = renderTasksNote({ idle, working });
  return latest?.content === rendered ? undefined : rendered;
}

function toListedTask(record: TaskRecord): ListedTask {
  return { id: record.id, tool: record.name };
}

/**
 * What each task whose call waits on a person waits for: a sign-in it stopped on, or else its
 * approval while it has one to wait for. One that runs waits on nobody.
 */
function personWaits(session: HarnessSession): ReadonlyMap<string, PersonWait> {
  const waits = new Map<string, PersonWait>();
  for (const step of suspendedSteps(session.state)) {
    for (const [callId, taskId] of Object.entries(step.taskIds ?? {})) {
      if (step.approved?.some(({ call }) => call.callId === callId) === true)
        waits.set(taskId, "sign-in");
      else if (
        !step.tasks.some((task) => task.callId === callId) &&
        step.requests.some(({ call }) => call.callId === callId)
      )
        waits.set(taskId, "approval");
    }
  }
  return waits;
}

function isTasksNote(message: ModelMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(TASKS_NOTE_LABEL)
  );
}
