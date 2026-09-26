import type { TaskWaitResult } from "#execution/tasks/calls.js";

// Every string the model reads about tasks lives in this file.

export const TASK_WAIT_DESCRIPTION =
  "Wait until one of your tasks has a result, a new message arrives, or timeout (in milliseconds) passes. Results arrive in a <task_result> message right after this call returns. Waiting never stops a task. Omit timeout to wait until a result or a message arrives; a timeout of 0 returns at once with any results that are ready.";

export const TASK_WAIT_TIMEOUT_DESCRIPTION = "How long to wait, in milliseconds.";

export const TASK_CANCEL_DESCRIPTION =
  "Stop a task's current work. That work never reports back; if it already had a result, that result is still delivered. An agent, or any task that accepts more input, stays available: call its tool with its taskId to give it new work.";

export const TASK_CANCEL_TASK_ID_DESCRIPTION = "The id of the task to stop.";

export const TASK_SYSTEM_BLOCK =
  "Every subagent call and some tools start a task and return its id right away; the task keeps working while you continue. Results arrive in <task_result> messages. When you need a result to continue, call task_wait; it returns when any task has a result. Start independent tasks first, then wait. To correct or continue an agent, or any task that accepts more input, call its tool again with its taskId. You cannot end your turn while tasks you started are working; eve waits for them and gives you their results. A new message interrupts your wait but not your tasks: decide whether it changes the work, then keep the tasks, correct an agent with taskId, or stop a task with task_cancel. Never use sleep to wait for a task.";

/** Labels the `context.state` note that lists the caller's tasks. */
export const TASKS_NOTE_LABEL = "[Tasks]";

/** Opens every block of a `task.result` message. */
export const TASK_RESULT_TAG = "<task_result";

/** The failure a task reports when its record could not be decoded. */
export const UNREADABLE_TASK_ERROR = "The task's state could not be read.";

const TASK_RESULTS_MAX_BYTES = 50 * 1024;
const TASK_RESULTS_MAX_LINES = 2_000;
const TRUNCATED_MARKER = "[truncated]";

export function renderTaskReceipt(taskId: string): string {
  return `Started task ${taskId}.`;
}

export function renderUnknownTaskError(taskId: string, tool: string): string {
  return `No task "${taskId}" is available to ${tool}: it may have ended or belong to another tool or caller. Start a new one by calling ${tool} without taskId.`;
}

export function renderTooManyTasksError(max: number, workingIds: readonly string[]): string {
  return `${String(max)} tasks are already working (${workingIds.join(", ")}). Wait with task_wait or stop one with task_cancel, then try again.`;
}

export function renderFinalOutputWhileWorkingError(workingIds: readonly string[]): string {
  return `You can't give your final output while tasks you started are working (${workingIds.join(", ")}). Wait for their results with task_wait, or stop a task with task_cancel, then call final_output.`;
}

/** How long a wait lasted, and how each task whose result follows ended. */
export interface TaskWaitDetails {
  readonly settledStatus: ReadonlyMap<string, "completed" | "failed">;
  readonly waitedMs: number;
}

/** What the model reads when `task_wait` returns. */
export function renderTaskWaitResult(result: TaskWaitResult, details: TaskWaitDetails): string {
  switch (result.status) {
    case "settled":
      return renderSettledWait(result.settled, result.working, details.settledStatus);
    case "timeout":
      return `Stopped waiting after ${formatDuration(details.waitedMs)}; ${countWorking(result.working)}. ${resultsArriveLater(result.working.length)}`;
    case "interrupt":
      return `A new message arrived, so the wait ended after ${formatDuration(details.waitedMs)}; ${countWorking(result.working)}. Read the message and decide whether it changes this work: ${interruptChoices(result.working.length)}`;
  }
}

function renderSettledWait(
  settled: readonly string[],
  working: readonly string[],
  settledStatus: TaskWaitDetails["settledStatus"],
): string {
  if (settled.length === 0 && working.length === 0) return "No tasks are working.";
  const sentences: string[] = [];
  if (settled.length > 0) {
    const outcomes = settled.map((id) => `${id} ${settledStatus.get(id) ?? "completed"}`);
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

/** One settled call's result, ready to render into a `task.result` message. */
export interface RenderedTaskResult {
  readonly body: string;
  readonly status: "completed" | "failed";
  readonly taskId: string;
  readonly tool: string;
}

/**
 * The `task.result` message: one `<task_result>` block per result. All
 * bodies share one size budget; a body past it is cut and marked.
 */
export function renderTaskResults(results: readonly RenderedTaskResult[]): string {
  const budget = { bytes: TASK_RESULTS_MAX_BYTES, lines: TASK_RESULTS_MAX_LINES };
  return results
    .map((result) => {
      const body = fitToBudget(escapeTaskResultBody(result.body), budget);
      const attributes = `id="${escapeAttribute(result.taskId)}" tool="${escapeAttribute(result.tool)}" status="${result.status}"`;
      return `${TASK_RESULT_TAG} ${attributes}>${body}</task_result>`;
    })
    .join("\n");
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

/** A tool's working tasks, as the `[Tasks]` note lists them. */
export interface ListedTask {
  readonly id: string;
  readonly tool: string;
}

export function renderTasksNote(working: readonly ListedTask[]): string {
  const tasks = working.map(
    (task) =>
      `<task id="${escapeAttribute(task.id)}" tool="${escapeAttribute(task.tool)}" status="working"/>`,
  );
  return [TASKS_NOTE_LABEL, "<tasks>", ...tasks, "</tasks>"].join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  if (seconds > 0) parts.push(`${String(seconds)}s`);
  return parts.join(" ");
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
