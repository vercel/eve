import type { TaskCancelResult, TaskWaitResult } from "#execution/tasks/calls.js";
import { formatDuration } from "#shared/format-duration.js";

// Every string the model reads about tasks lives in this file.

export const TASK_WAIT_DESCRIPTION =
  "Call task_wait sparingly, only when you deliberately want to withhold a message from the user while waiting for a task result. Tasks keep running and their results reach you without calling task_wait. If the user should hear from you now, reply instead. Wait silently until any of your tasks has a result, a new message arrives, or timeoutSeconds pass. It returns after the first result, which follows in a <task_result> message; wait again only if you still want to withhold a reply until another result arrives. Waiting never stops a task.";

export const TASK_WAIT_TIMEOUT_DESCRIPTION =
  "Optional. Seconds to wait before returning without a result. Omit it to wait for a result or a new message, which is almost always right. Don't use short timeouts to check on tasks: results reach you without checking.";

export const TASK_CANCEL_DESCRIPTION =
  "Stop a task's current work. That work never reports back; if it already had a result, that result is still delivered. An agent, or any task that accepts more input, stays available: call its tool with its taskId to give it new work.";

const TASK_ID_SOURCE = 'copied from its "Started task" receipt or the [Tasks] note';

export const TASK_CANCEL_TASK_ID_DESCRIPTION = `The id of the task to stop, ${TASK_ID_SOURCE}.`;

const TASK_SYSTEM_BLOCK_OPENING = [
  "Tasks",
  '- A call that returns "Started task <id>" is a task: it keeps working while you continue. Every agent call is a task.',
  "- Each result arrives once, in a <task_result> message. Until then you know nothing about it, so don't guess or report its result.",
  "- Ending your reply doesn't end your turn. While tasks work, eve holds your turn and calls you again with each result.",
];

const TASK_SYSTEM_BLOCK_CLOSING = [
  "- Don't redo work you delegated. Never use sleep or shell commands to wait for a task.",
  "- To correct or continue an agent, or any task that accepts more input, call its tool again with its taskId. A new message never stops your tasks: answer it if it asks you something, decide whether it changes the work, then keep each task, correct an agent by taskId, or stop a task with task_cancel.",
];

/** The task block for a session a person reads, where a reply before a result is posted. */
export const TASK_SYSTEM_BLOCK = [
  ...TASK_SYSTEM_BLOCK_OPENING,
  "- If you have nothing to tell the person until a result arrives, call task_wait. Start every independent task first, then wait.",
  "- If the person should hear from you now, for example to confirm work is underway when they don't need the result yet, reply. When results arrive, report them without repeating yourself.",
  ...TASK_SYSTEM_BLOCK_CLOSING,
].join("\n");

/** The task block for a child or schedule session, whose caller reads only the final reply. */
export const FINAL_REPLY_TASK_SYSTEM_BLOCK = [
  ...TASK_SYSTEM_BLOCK_OPENING,
  "- Only your final reply reaches your caller. While tasks work, call task_wait instead of replying. Start every independent task first, then wait.",
  ...TASK_SYSTEM_BLOCK_CLOSING,
].join("\n");

/** Appended to a `serve` tool's description. */
export const SERVE_TOOL_DESCRIPTION =
  "To send this task more input, call this tool again with its taskId; without taskId, each call starts a new task.";

/** Appended to an agent tool's description, in place of the `serve` tool sentence. */
export const AGENT_SERVE_TOOL_DESCRIPTION =
  "It does not see this conversation, so put everything it needs in message. To correct or continue an agent task, call this tool again with its taskId; without taskId, each call starts a new agent.";

/** Describes the `taskId` eve adds to a `serve` tool's model input. */
export const TASK_ID_INPUT_DESCRIPTION = `The id of a task this tool started, ${TASK_ID_SOURCE}, to send it this input. Omit it to start a new task.`;

/** Labels the `context.state` note that lists the turn's tasks. */
export const TASKS_NOTE_LABEL = "[Tasks]";

/** Opens every block of a `task.result` message. */
export const TASK_RESULT_TAG = "<task_result";

/** The failure a task reports when its record could not be decoded. */
export const UNREADABLE_TASK_ERROR = "The task's state could not be read.";

const TASK_RESULTS_MAX_BYTES = 50 * 1024;
const TASK_RESULTS_MAX_LINES = 2_000;
const TRUNCATED_MARKER = "[truncated]";

/** The receipt for a call that starts a task; a resumable task's says how to reach it again. */
export function renderTaskReceipt(task: {
  readonly id: string;
  readonly resumable: boolean;
  readonly tool: string;
}): string {
  const started = `Started task ${task.id}. Its result will arrive in a <task_result> message.`;
  if (!task.resumable) return started;
  return `${started} To send it another message, call ${task.tool} again with taskId ${task.id}.`;
}

/** The receipt for a call that reaches a resumable task by its `taskId`. */
export function renderTaskSentReceipt(taskId: string): string {
  return `Sent to task ${taskId}. Its reply will arrive in a <task_result> message.`;
}

export function renderUnknownTaskError(taskId: string, tool: string): string {
  return `No task "${taskId}" is available to ${tool}: it may have ended or belong to another tool. Start a new one by calling ${tool} without taskId.`;
}

export function renderUnknownCancelTaskError(taskId: string): string {
  return `No task "${taskId}" is in this session. Copy an id from a "Started task" receipt or the [Tasks] note.`;
}

/** What the model reads when `task_cancel` answers. */
export function renderTaskCancelResult(taskId: string, result: TaskCancelResult): string {
  if (result.status === "already_finished") return `${taskId} had no work to stop.`;
  if (!result.resumable) return `Stopped ${taskId}; it won't report back.`;
  return `Stopped ${taskId}'s current work; it won't report back. To give it new work, call ${result.tool} again with taskId ${taskId}.`;
}

export function renderTooManyTasksError(max: number, workingIds: readonly string[]): string {
  return `${String(max)} tasks are already working (${workingIds.join(", ")}). Wait with task_wait or stop one with task_cancel, then try again.`;
}

export function renderFinalOutputWhileWorkingError(workingIds: readonly string[]): string {
  return `You can't give your final output while tasks you started are working (${workingIds.join(", ")}). Wait for their results with task_wait, or stop a task with task_cancel, then call final_output.`;
}

/** What the model reads when `task_wait` returns after waiting `waitedMs`. */
export function renderTaskWaitResult(result: TaskWaitResult, waitedMs: number): string {
  switch (result.status) {
    case "settled":
      return renderSettledWait(result.settled, result.working);
    case "timeout":
      return `Stopped waiting after ${formatDuration(waitedMs)}; ${countWorking(result.working)}. ${resultsArriveLater(result.working.length)}`;
    case "interrupt":
      return `A new message arrived, so the wait ended after ${formatDuration(waitedMs)}; ${countWorking(result.working)}. Read the message, answer it if it asks you something, and decide whether it changes this work: ${interruptChoices(result.working.length)}`;
  }
}

function renderSettledWait(
  settled: Extract<TaskWaitResult, { readonly status: "settled" }>["settled"],
  working: readonly string[],
): string {
  if (settled.length === 0 && working.length === 0) return "No tasks are working.";
  const sentences: string[] = [];
  if (settled.length > 0) {
    const outcomes = settled.map((task) => `${task.id} ${task.status}`);
    const follows = settled.length === 1 ? "its result follows" : "their results follow";
    sentences.push(`${joinList(outcomes)}; ${follows}.`);
  }
  if (working.length > 0) {
    sentences.push(`${capitalize(countWorking(working))}: ${working.join(", ")}.`);
  }
  return sentences.join(" ");
}

function countWorking(working: readonly string[]): string {
  return working.length === 1
    ? "1 task is still working"
    : `${String(working.length)} tasks are still working`;
}

function resultsArriveLater(workingCount: number): string {
  return workingCount === 1
    ? "Its result arrives before your turn ends; wait again only if you need it now."
    : "Their results arrive before your turn ends; wait again only if you need them now.";
}

function interruptChoices(workingCount: number): string {
  const keep = workingCount === 1 ? "keep the task" : "keep the tasks";
  return `${keep}, call an agent again with its taskId to correct it, or stop a task with task_cancel.`;
}

/** One `<task_result>` block of a `task.result` message. */
export interface TaskResultBlock {
  readonly body: string;
  readonly status: "completed" | "failed";
  readonly taskId: string;
  readonly tool: string;
}

/**
 * The `task.result` message: one `<task_result>` block per result. All
 * bodies share one size budget; a body past it is cut and marked.
 */
export function renderTaskResults(results: readonly TaskResultBlock[]): string {
  const budget = { bytes: TASK_RESULTS_MAX_BYTES, lines: TASK_RESULTS_MAX_LINES };
  return results
    .map((result) => {
      const body = fitToBudget(escapeTaskResultBody(result.body), budget);
      const attributes = `id="${escapeAttribute(result.taskId)}" tool="${escapeAttribute(result.tool)}" status="${result.status}"`;
      return `${TASK_RESULT_TAG} ${attributes}>${body}</task_result>`;
    })
    .join("\n");
}

const TASK_RESULT_BLOCK = new RegExp(
  `${TASK_RESULT_TAG} id="([^"]*)" tool="([^"]*)" status="(completed|failed)">([\\s\\S]*?)</task_result>`,
  "g",
);

/**
 * The blocks of a `task.result` message, in order, as a deterministic mock
 * model reads them back; empty for any other text.
 */
export function readTaskResults(message: string): TaskResultBlock[] {
  return [...message.matchAll(TASK_RESULT_BLOCK)].map(([, taskId, tool, status, body]) => ({
    body: body!.replaceAll("<\\/task_result", "</task_result"),
    status: status as TaskResultBlock["status"],
    taskId: taskId!,
    tool: tool!,
  }));
}

function fitToBudget(body: string, budget: { bytes: number; lines: number }): string {
  const encoder = new TextEncoder();
  const lines = body.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const cost = encoder.encode(line).byteLength + 1;
    if (budget.lines === 0 || cost > budget.bytes) {
      kept.push(TRUNCATED_MARKER);
      budget.lines = 0;
      budget.bytes = 0;
      break;
    }
    kept.push(line);
    budget.lines -= 1;
    budget.bytes -= cost;
  }
  return kept.join("\n");
}

function escapeTaskResultBody(body: string): string {
  return body.replaceAll("</task_result", "<\\/task_result");
}

/** The text of a tool's `toModelOutput` result, or of a raw output without one. */
export function renderModelOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (isModelOutput(output)) {
    switch (output.type) {
      case "text":
        return String(output.value);
      case "json":
        return JSON.stringify(output.value);
      case "content":
        return renderContentParts(output.value);
    }
  }
  return JSON.stringify(output ?? null);
}

function renderContentParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: { type?: unknown; text?: unknown; filename?: unknown; mediaType?: unknown }) => {
      if (part.type === "text") return String(part.text);
      const label = typeof part.filename === "string" ? part.filename : String(part.mediaType);
      return `[file: ${label}]`;
    })
    .join("\n");
}

function isModelOutput(
  value: unknown,
): value is { readonly type: "text" | "json" | "content"; readonly value: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const type = Reflect.get(value, "type");
  return (type === "text" || type === "json" || type === "content") && "value" in value;
}

/** A task as the `[Tasks]` note lists it. */
export interface ListedTask {
  readonly id: string;
  readonly tool: string;
}

/** The `[Tasks]` note: working tasks, then idle resumable tasks when there are any. */
export function renderTasksNote(input: {
  readonly idle: readonly ListedTask[];
  readonly working: readonly ListedTask[];
}): string {
  const lines = [TASKS_NOTE_LABEL, "<tasks>"];
  for (const task of input.working) {
    lines.push(`<task ${listedTaskAttributes(task)} status="working"/>`);
  }
  lines.push("</tasks>");
  if (input.idle.length > 0) {
    lines.push("<idle>");
    for (const task of input.idle) lines.push(`<task ${listedTaskAttributes(task)}/>`);
    lines.push("</idle>");
  }
  return lines.join("\n");
}

function listedTaskAttributes(task: ListedTask): string {
  return `id="${escapeAttribute(task.id)}" tool="${escapeAttribute(task.tool)}"`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
