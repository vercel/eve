import type { ModelMessage, SystemModelMessage } from "ai";

import {
  TASK_CANCEL_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  type TaskKernelCall,
} from "#execution/tasks/calls.js";
import {
  renderModelOutputText,
  renderTaskResults,
  renderTasksNote,
  TASK_SYSTEM_BLOCK,
  TASKS_NOTE_LABEL,
  type ListedTask,
  type RenderedTaskResult,
} from "#execution/tasks/render.js";
import {
  createTask,
  idleTasks,
  readTaskTable,
  takeTaskResults,
  workingTasks,
  writeTaskTable,
  type DeliveredTaskResult,
  type TaskRecord,
} from "#execution/tasks/table.js";
import { splitTaskIdInput } from "#execution/tasks/task-id-input.js";
import { entryPointOf, startsTasks } from "#execution/tasks/tool-entry-point.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import type { HarnessEmitFn, HarnessSession, HarnessToolMap } from "#harness/types.js";
import { createMessageReceivedEvent } from "#protocol/message.js";
import type { WorkflowToolCallEntry } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import { taskCancelTool } from "#tools/provided/task-cancel.js";
import { taskWaitTool } from "#tools/provided/task-wait.js";

// What the model step does for tasks: it offers the kernel's tools, commits a
// record for each call that starts a task, delivers settled results, keeps the
// `[Tasks]` note current, and tells the turn rule which tasks still work.

export function isTaskKernelTool(definition: HarnessToolDefinition | undefined): boolean {
  return (
    definition?.frameworkAction === "task-wait" || definition?.frameworkAction === "task-cancel"
  );
}

/** Whether the agent can start tasks, so the kernel's tools and system block are offered. */
export function offersTasks(tools: HarnessToolMap): boolean {
  for (const definition of tools.values()) {
    if (startsTasks(definition)) return true;
  }
  return false;
}

/** Adds `task_wait` and `task_cancel` to a tool set that can start tasks. */
export function withTaskKernelTools(tools: HarnessToolMap): HarnessToolMap {
  if (!offersTasks(tools)) return tools;
  return new Map([
    ...tools,
    [TASK_WAIT_TOOL_NAME, taskWaitTool],
    [TASK_CANCEL_TOOL_NAME, taskCancelTool],
  ]);
}

export function taskSystemMessages(tools: HarnessToolMap): SystemModelMessage[] {
  return offersTasks(tools) ? [{ content: TASK_SYSTEM_BLOCK, role: "system" }] : [];
}

/** A deferred call as the model made it, before the session knows what it enters. */
export interface DeferredCall {
  readonly callId: string;
  readonly definition: HarnessToolDefinition | undefined;
  /** The call's model input. */
  readonly input: JsonObject;
  readonly principal: string;
  readonly toolName: string;
  readonly turnId: string;
}

/** How a deferred call enters its workflow, with the tool's own input. */
export interface CommittedCallEntry {
  readonly entry: WorkflowToolCallEntry;
  readonly input: JsonObject;
  readonly session: HarnessSession;
}

/**
 * How a deferred call enters its workflow. A call that starts a task commits
 * the task's record alongside the call, so the run starts with its id; a
 * `serve` tool's call with `taskId` goes to that task's `receive()`, which the
 * session checks when it sends the call.
 */
export function commitCallEntry(session: HarnessSession, call: DeferredCall): CommittedCallEntry {
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
  call: DeferredCall,
  entryPoint: "task" | "serve",
  input: JsonObject,
): CommittedCallEntry {
  const created = createTask(readTaskTable(session.state), {
    callId: call.callId,
    creator: call.principal,
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

export function toTaskKernelCall(input: {
  readonly callId: string;
  readonly definition: HarnessToolDefinition;
  readonly input: JsonObject;
}): TaskKernelCall {
  if (input.definition.frameworkAction === "task-cancel") {
    return { callId: input.callId, kind: "task_cancel", taskId: String(input.input.taskId) };
  }
  const timeout = input.input.timeout;
  return typeof timeout === "number"
    ? { callId: input.callId, kind: "task_wait", timeoutMs: timeout }
    : { callId: input.callId, kind: "task_wait" };
}

export function workingTaskIds(session: HarnessSession, principal: string): readonly string[] {
  return workingTasks(readTaskTable(session.state), principal).map((record) => record.id);
}

/**
 * The messages a model step appends for tasks, before any new input: one
 * `task.result` message with the principal's settled results, then the
 * `[Tasks]` note when the listing changed. The results are marked delivered
 * in the same step, and the stream reports the message as `message.received`.
 */
export async function appendTaskContext(input: {
  readonly emit: HarnessEmitFn | undefined;
  readonly emissionState: HarnessEmissionState;
  readonly messages: readonly HarnessModelMessage[];
  readonly principal: string;
  readonly projectHistory: (
    messages: readonly ModelMessage[],
    state: HarnessSession["state"],
  ) => readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly messages: readonly HarnessModelMessage[];
  readonly session: HarnessSession;
}> {
  const appended: HarnessModelMessage[] = [];
  const delivery = await deliverTaskResults(input);
  if (delivery.message !== undefined) {
    appended.push(createFrameworkUserMessage("task.result", delivery.message));
    await input.emit?.(
      createMessageReceivedEvent({
        kind: "task.result",
        message: delivery.message,
        sequence: input.emissionState.sequence,
        turnId: activeTurnId(input.emissionState),
      }),
    );
  }
  const note = resolveTasksNote({
    messages: input.projectHistory([...input.messages, ...appended], delivery.session.state),
    principal: input.principal,
    session: delivery.session,
  });
  if (note !== undefined) appended.push(createFrameworkUserMessage("context.state", note));
  return { messages: appended, session: delivery.session };
}

/**
 * Takes the principal's settled results for one `task.result` message and
 * marks them delivered in the same step that appends the message.
 */
async function deliverTaskResults(input: {
  readonly principal: string;
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{ readonly message?: string; readonly session: HarnessSession }> {
  const taken = takeTaskResults(readTaskTable(input.session.state), input.principal);
  if (taken.delivered.length === 0) return { session: input.session };
  const rendered: RenderedTaskResult[] = [];
  for (const delivered of taken.delivered) {
    rendered.push(await renderDeliveredResult(delivered, input.tools.get(delivered.name)));
  }
  return {
    message: renderTaskResults(rendered),
    session: writeTaskTable(input.session, taken.table),
  };
}

async function renderDeliveredResult(
  delivered: DeliveredTaskResult,
  definition: HarnessToolDefinition | undefined,
): Promise<RenderedTaskResult> {
  const { result } = delivered;
  const base = { taskId: delivered.taskId, tool: delivered.name };
  if (result.status === "failed") return { ...base, body: result.error, status: "failed" };
  return { ...base, body: await projectOutput(result.output, definition), status: "completed" };
}

async function projectOutput(
  output: unknown,
  definition: HarnessToolDefinition | undefined,
): Promise<string> {
  if (definition?.toModelOutput === undefined) return renderModelOutputText(output);
  try {
    return renderModelOutputText(await definition.toModelOutput(output));
  } catch {
    // A projection that throws must not wedge every later model step.
    return renderModelOutputText(output);
  }
}

/**
 * The `[Tasks]` note to append when the principal's listing differs from the
 * latest one in history. Compaction drops old notes, so the listing returns.
 */
function resolveTasksNote(input: {
  readonly messages: readonly ModelMessage[];
  readonly principal: string;
  readonly session: HarnessSession;
}): string | undefined {
  const table = readTaskTable(input.session.state);
  const working = workingTasks(table, input.principal).map(toListedTask);
  const idle = idleTasks(table, input.principal).map(toListedTask);
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
