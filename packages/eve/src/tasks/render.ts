import type { ModelMessage } from "ai";

import { truncateHead } from "#execution/sandbox/truncate-output.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskKind, TaskOutcome } from "#tasks/protocol.js";
import { isIdleTask, type TaskRecord } from "#tasks/record.js";
import type { ToolModelOutput } from "#tools/model-output.js";

// Every string the model reads about tasks lives in this module.

/** Label prefixing the framework-authored `[Tasks]` note. */
export const TASKS_NOTE_LABEL = "[Tasks]";

/** Idle tasks listed in the `[Tasks]` note, most recent first. */
const MAX_IDLE_TASKS = 10;

const EMPTY_TASKS_NOTE = [TASKS_NOTE_LABEL, "<tasks>", "</tasks>", "<idle>", "</idle>"].join("\n");

/** Structured receipt returned to clients for a detached call. */
export interface TaskReceipt {
  readonly status: "working";
  readonly taskId: string;
}

function noun(kind: TaskKind): "agent" | "task" {
  return kind === "agent" ? "agent" : "task";
}

/** Receipt text for a call that started a detached task; a resumable task also takes sends. */
export function renderStartReceipt(
  record: Pick<TaskRecord, "id" | "name" | "resumable">,
  toolName: string,
): string {
  return record.resumable === true
    ? `Started task ${record.id}. Call ${toolName} again with taskId ${record.id} to send it more input; use task_wait for its result.`
    : `Started task ${record.id}. Use task_wait for its result.`;
}

/** Receipt text for a send: to a working task, or to an idle one it started again. */
export function renderSendReceipt(record: Pick<TaskRecord, "id">, started: boolean): string {
  return started
    ? `Sent to task ${record.id}, which is now working on it. Use task_wait for its result.`
    : `Sent to task ${record.id}, which is still working. It uses your input in its current work or starts on it right after; use task_wait for its next result.`;
}

/** Sentence eve appends to the description of every resumable tool. */
export const RESUMABLE_TOOL_DESCRIPTION =
  "To correct or continue a task this tool started, call it again with that task's taskId; without taskId, each call starts a new task.";

/** Description of the `taskId` input on every resumable tool. */
export const TASK_ID_SEND_PARAMETER_DESCRIPTION =
  "Only to correct or continue a task this tool started: that task's id, from its receipt or the latest [Tasks] note. An idle task starts on this input; a working one uses it in its current work or starts on it right after. Omit it to start a new task.";

/** Error message for a send whose input does not match the tool's input schema. */
export const SEND_INPUT_SCHEMA_HINT =
  "A call with taskId sends input, so it uses this tool's input schema too.";

/** Result of a generation started for a send the task never read before it ended. */
export const TASK_ENDED_BEFORE_READ_MESSAGE = "The task ended before it read this input.";

/** Result of a generation still working when its task ended. */
export const TASK_ENDED_BEFORE_REPLY_MESSAGE = "The task ended before it replied.";

/** Tool result for an attached call that a new message ended. */
export function renderInterruptedCall(waitedMs: number): string {
  return `Stopped after ${formatDuration(waitedMs)} because a new message arrived.`;
}

/**
 * Truncates a task result the model reads, whether an attached call, a
 * `task_wait`, or a `task.result` message delivers it: 50 KB and 2,000
 * lines, with `[truncated]` marking the cut. A line longer than 2,000
 * characters is cut the same way.
 */
export function truncateTaskResult(text: string): string {
  return truncateTaskResultParts([text])[0]!;
}

/**
 * Truncates the text parts of one result under a single shared limit, so
 * the parts together stay within it. Parts past the cut are dropped, and the
 * part that holds the cut ends with the `[truncated]` line.
 */
export function truncateTaskResultParts(texts: readonly string[]): string[] {
  const joined = texts.join("\n");
  const truncated = truncateHead(joined);
  if (truncated.output === joined) return [...texts];
  // The per-line cut keeps every line, so kept lines map back onto the parts in order.
  const kept = truncated.output.split("\n");
  const parts: string[] = [];
  let offset = 0;
  for (const text of texts) {
    if (offset >= kept.length) break;
    const lineCount = text.split("\n").length;
    parts.push(kept.slice(offset, offset + lineCount).join("\n"));
    offset += lineCount;
  }
  if (truncated.truncated) parts[parts.length - 1] += "\n[truncated]";
  return parts;
}

/** One `<task_result>` block per result, truncated like a waited call's result. */
export function renderTaskResults(
  results: readonly {
    readonly record: Pick<TaskRecord, "id" | "name">;
    readonly outcome: TaskOutcome;
    readonly body?: string;
  }[],
): string {
  return results
    .map(({ body, outcome, record }) => {
      const code =
        outcome.status === "failed" ? ` code="${escapeAttribute(outcome.error.code)}"` : "";
      const text = body ?? renderOutcomeBody(outcome);
      return `<task_result id="${escapeAttribute(record.id)}" name="${escapeAttribute(record.name)}" status="${outcome.status}"${code}>\n${escapeResultBody(truncateTaskResult(text))}\n</task_result>`;
    })
    .join("\n");
}

/** Default body for a result without a `toModelOutput` projection. */
export function renderOutcomeBody(outcome: TaskOutcome): string {
  switch (outcome.status) {
    case "completed":
      return stringifyOutput(outcome.output);
    case "failed":
      return outcome.error.message;
    case "cancelled":
      return "The task was cancelled.";
  }
}

/**
 * Returns a `[Tasks]` note to append when the listing differs from the
 * latest note in history, or `undefined` when it is unchanged. A session
 * that never listed anything gets no note.
 */
export function resolveTasksAnnouncement(input: {
  readonly messages: readonly ModelMessage[];
  readonly records: readonly TaskRecord[];
}): string | undefined {
  // A person's message that happens to start with the label is not a note.
  const latest = input.messages.findLast(
    (message) =>
      message.role === "user" &&
      (message as { readonly kind?: unknown }).kind === "context.state" &&
      typeof message.content === "string" &&
      message.content.startsWith(TASKS_NOTE_LABEL),
  );
  const rendered = renderTasksNote(input.records);
  if (rendered === undefined) {
    return latest === undefined || latest.content === EMPTY_TASKS_NOTE
      ? undefined
      : EMPTY_TASKS_NOTE;
  }
  return latest?.content === rendered ? undefined : rendered;
}

/**
 * The `[Tasks]` note: every detached task whose result has not reached
 * history, plus the most recent idle tasks, agents and resumable workflow
 * tools alike, each with the tool that takes its `taskId`. Returns
 * `undefined` when there is nothing to list.
 */
export function renderTasksNote(records: readonly TaskRecord[]): string | undefined {
  const tasks = records.filter((record) => record.mode === "detached" && !record.delivered);
  const idle = records
    .filter(isIdleTask)
    .toSorted((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, MAX_IDLE_TASKS);
  if (tasks.length === 0 && idle.length === 0) return undefined;
  const lines = [TASKS_NOTE_LABEL, "<tasks>"];
  for (const task of tasks) {
    lines.push(
      `<task id="${escapeAttribute(task.id)}" name="${escapeAttribute(task.name)}" status="${task.status}" started="${formatMinute(task.startedAt)}"/>`,
    );
  }
  lines.push("</tasks>", "<idle>");
  for (const task of idle) {
    lines.push(
      `<task id="${escapeAttribute(task.id)}" tool="${escapeAttribute(task.name)}">${escapeText(task.lastStatus ?? "")}</task>`,
    );
  }
  lines.push("</idle>");
  return lines.join("\n");
}

/** How a model-written workflow program calls agents with `ctx.agent`. */
export const WORKFLOW_PROGRAM_AGENT_CONTRACT =
  "Call ctx.agent(name, { message: string, taskId?: string, outputSchema?: object }). It resolves directly to the child's JSON-serializable output; when outputSchema is provided, the output matches that schema. It does not return an agent metadata wrapper. Pass an idle agent's task id from the conversation's [Tasks] note as taskId to continue that child. The owning agent resolves the target and applies its existing availability and authorization checks.";

/** Output of `task_cancel`. */
export interface TaskCancelOutput {
  readonly status: "cancelled" | "already_finished";
}

export const TASK_CANCEL_DESCRIPTION =
  "Stop a task's current work and any input queued for it. That work never reports back; if it already finished, its result is still delivered. Agents, and some other tasks, stay available afterwards: if the [Tasks] note lists the task as idle, call its tool with its taskId to give it new work.";

/** Description of the `taskId` input of `task_cancel` and `task_wait`. */
export const TASK_ID_PARAMETER_DESCRIPTION =
  "The id of a task or agent, from its receipt or the latest [Tasks] note.";

/** Error message for a `task_cancel` call whose input could not be read. */
export const TASK_CANCEL_INVALID_INPUT_MESSAGE =
  "task_cancel needs taskId: the id of one task or agent.";

export const TASK_WAIT_DESCRIPTION =
  "Wait for a task's next result. Returns when the task has a result you have not seen, when timeout (in milliseconds) passes, or when a new message arrives. Ending a wait never stops the task. To wait on several tasks, call task_wait once for each in the same step. Omit timeout to wait until the result arrives; a timeout of 0 returns at once with the task's current state.";

/** Description of the `timeout` input of `task_wait`. */
export const TASK_WAIT_TIMEOUT_DESCRIPTION =
  "How long to wait, in milliseconds. Omit it to wait until the result arrives; 0 returns at once.";

/** Error message for a `task_wait` call whose input could not be read. */
export const TASK_WAIT_INVALID_INPUT_MESSAGE =
  "task_wait needs taskId, the id of one task or agent, and an optional timeout in milliseconds (0 or more).";

/** Result of a `task_wait` whose timeout passed first, including a timeout of 0. */
export function renderWaitTimedOut(
  record: Pick<TaskRecord, "id" | "status">,
  waitedMs: number,
): string {
  return `Stopped waiting after ${formatDuration(waitedMs)}; ${describeOpenTask(record)}. Its result arrives in a later message before your turn ends; wait again only if you need it now.`;
}

/** Result of a `task_wait` that a new message ended. */
export function renderWaitInterrupted(
  record: Pick<TaskRecord, "id" | "name" | "resumable" | "status">,
  waitedMs: number,
): string {
  const choices =
    record.resumable === true
      ? `keep the task, call ${record.name} again with its taskId to correct it, or stop it with task_cancel`
      : "keep the task or stop it with task_cancel";
  return `A new message arrived, so the wait ended after ${formatDuration(waitedMs)}; ${describeOpenTask(record)}. Read the message and decide whether it changes this work: ${choices}.`;
}

/** The current state of a task a wait ended on before it finished. */
function describeOpenTask(record: Pick<TaskRecord, "id" | "status">): string {
  return record.status === "input_required"
    ? `${record.id} is waiting on a person`
    : `${record.id} is still working`;
}

/** Result of a `task_wait` on an idle task with nothing new. */
export function renderWaitIdle(record: Pick<TaskRecord, "id" | "name">): string {
  return `${record.id} is idle and has no new result. Call ${record.name} with its taskId to give it more work.`;
}

/** `UNKNOWN_TASK` error message for `task_wait` and `task_cancel`. */
export function renderUnknownTask(taskId: string): string {
  return `No open task "${taskId}" in this session; it may have ended. The latest [Tasks] note lists open tasks.`;
}

/** `TASK_OTHER_PRINCIPAL` error message for a task a different caller started. */
export function renderTaskOtherPrincipal(taskId: string): string {
  return `Task "${taskId}" was started by a different caller, so you can't use it. Start a new one by calling its tool without taskId.`;
}

/** `UNKNOWN_TASK` error message for a send to a task that is gone or never took input. */
export function renderUnknownSendTask(taskId: string, toolName: string): string {
  return `No open task "${taskId}" in this session; it may have ended. Start a new one by calling ${toolName} without taskId.`;
}

/** `TASK_MISMATCH` error message for a send to another tool's task. */
export function renderTaskMismatch(record: Pick<TaskRecord, "id" | "name">): string {
  return `Task "${record.id}" belongs to ${record.name}; call ${record.name} with it.`;
}

/**
 * `TASK_BUSY` error for a send a task cannot take: a model's send to an agent
 * whose current work a workflow body awaits (`workflow-owned`), or a
 * workflow body's send to an agent that is still working (`workflow-caller`).
 * A workflow body awaits the result of the work it started.
 */
export function renderTaskBusy(
  taskId: string,
  toolName: string,
  reason: "workflow-caller" | "workflow-owned",
): string {
  switch (reason) {
    case "workflow-caller":
      return `Task "${taskId}" is still working on another call, so a workflow can't give it more input until it answers. Omit taskId to start a new one.`;
    case "workflow-owned":
      return `Task "${taskId}" is working for a workflow tool call and can't take input until it answers. Start a new one by calling ${toolName} without taskId.`;
  }
}

/**
 * `TASK_UNREACHABLE` error message for a send the task's child could not
 * take. `ended`: the child is gone for good; `temporary`: a later send may
 * reach it.
 */
export function renderTaskUnreachable(
  record: Pick<TaskRecord, "id" | "kind" | "name">,
  reason: "ended" | "temporary",
): string {
  if (reason === "temporary") return `Task "${record.id}" is temporarily unreachable. Try again.`;
  const why = record.kind === "agent" ? "its agent session ended" : "its workflow run ended";
  return `Task "${record.id}" can no longer take input: ${why}. Start a new one by calling ${record.name} without taskId.`;
}

/** `TASK_ALREADY_WAITED` error message for a second `task_wait` on one task in a step. */
export function renderTaskAlreadyWaited(taskId: string): string {
  return `Another task_wait in this step already waits for task "${taskId}"; use that call's result.`;
}

/**
 * Static system block, offered with `task_wait` and `task_cancel` in every
 * session whose agent can start a detached task. With agents or resumable
 * workflow tools, it also explains how to continue or correct a task by
 * calling its tool with its `taskId`.
 */
export function renderTasksInstruction(options: {
  readonly agents: boolean;
  readonly resumable: boolean;
}): string {
  const starts = options.agents
    ? "Every agent call and most workflow tool calls start a task and return its id right away"
    : "Most workflow tool calls start a task and return its id right away";
  const choices = options.resumable
    ? "keep the tasks, correct them by calling their tool again with their taskId, or stop them with task_cancel"
    : "keep the tasks or stop them with task_cancel";
  const sentences = [
    `${starts}; the task keeps working while you continue.`,
    "When the user needs the answer to continue, wait for it with task_wait. Start independent tasks first, then wait on them in the same step, one task_wait per task.",
  ];
  if (options.resumable) {
    sentences.push("To correct or continue a task, call its tool again with its taskId.");
  }
  sentences.push(
    "A result you don't wait for arrives in a <task_result> message.",
    "You cannot end your turn while tasks you started are working; eve waits for them and gives you their results.",
    `A new message interrupts your waits but not your tasks: decide whether it changes the work, then ${choices}.`,
    "Never use sleep to wait for a task.",
  );
  if (options.agents) {
    sentences.push(
      "Agents stay available after they answer: call an idle agent's tool with its taskId to give it more work in its existing session. Any agent tool can always be called without taskId to start a new agent, even when the [Tasks] note is empty or absent.",
    );
  }
  sentences.push(
    `The latest [Tasks] note lists working tasks${options.resumable ? " and idle tasks with their tools" : ""}; eve adds it whenever the listing changes, and it never needs a reply.`,
  );
  return `Tasks\n${sentences.join(" ")}`;
}

/** `TOO_MANY_TASKS` error message for a start over the working-task cap. */
export function renderTooManyTasks(ids: readonly string[], limit: number): string {
  return `${limit} tasks are already working (${ids.join(", ")}). Wait for one with task_wait or stop one with task_cancel, then try again.`;
}

/** Tool result for a `final_output` call made while tasks the turn started are working. */
export function renderFinalOutputWhileTasksWork(taskIds: readonly string[]): string {
  return `You can't give your final output while tasks you started are working (${taskIds.join(", ")}). Wait for them with task_wait or stop them with task_cancel, then call final_output again.`;
}

/** Error message for a delegated call whose agent session ended before it replied. */
export const AGENT_SESSION_ENDED_MESSAGE = "The agent's session ended before it replied.";

/** Error message for an agent call the owner cancelled. */
export const AGENT_CALL_CANCELLED_MESSAGE = "The agent invocation was cancelled.";

/** Error message for a workflow tool run that failed before it could report its result. */
export const WORKFLOW_RUN_ENDED_WITHOUT_RESULT_MESSAGE =
  "The workflow tool run failed before it reported its result.";

/** `STATE_LOST` error message for a task whose stored record eve could not read. */
export const STATE_LOST_MESSAGE =
  "eve could not read this task's saved state, so its result is lost. Start it again if it is still needed.";

/**
 * `TIMED_OUT` error message for a call still working at its time limit. A
 * record from before eve stored the limit names no duration.
 */
export function renderTimedOut(kind: TaskKind, timeoutMs: number | undefined): string {
  const limit = timeoutMs === undefined ? "its time limit" : formatDuration(timeoutMs);
  return `The ${noun(kind)} did not finish within ${limit} and was stopped.`;
}

/**
 * Message for a remote agent whose deployment speaks another task protocol
 * version, or reports none because it runs an older eve: `START_FAILED` at
 * start, `TASK_UNREACHABLE` for a send to a working agent.
 */
export function renderTaskProtocolMismatch(input: {
  readonly name: string;
  readonly localVersion: number;
  readonly remoteVersion: number | undefined;
}): string {
  const remote =
    input.remoteVersion === undefined
      ? "reports no task protocol version (it runs an older eve)"
      : `uses task protocol version ${String(input.remoteVersion)}`;
  return `Remote agent "${input.name}" cannot be called: its deployment ${remote}, and this deployment uses version ${String(input.localVersion)}. Upgrade so both deployments use the same task protocol version.`;
}

/** Message for a request to a remote agent that got no response within its time limit. */
export function renderRemoteAgentRequestTimedOut(input: {
  readonly name: string;
  /** What the request asked for, such as "create-session". */
  readonly request: string;
  readonly timeoutMs: number;
}): string {
  return `Remote agent "${input.name}" did not answer the ${input.request} request within ${formatDuration(input.timeoutMs)}.`;
}

/** `EMPTY_RESULT` error for an agent whose answer has no text. */
export function renderEmptyResult(name: string): string {
  return `Agent "${name}" finished without a reply. If you still need its answer, call its tool again with its taskId.`;
}

/** Error for a `ctx.agent` call whose child closed its reply channel without answering. */
export function renderAgentClosedWithoutResult(target: string): string {
  return `Agent "${target}" closed without a result.`;
}

const LAST_STATUS_MAX_LENGTH = 200;

/** One-line summary of a task's latest result, listed with idle tasks in the `[Tasks]` note. */
export function renderLastStatus(outcome: TaskOutcome): string {
  const text =
    outcome.status === "completed"
      ? typeof outcome.output === "string"
        ? outcome.output
        : JSON.stringify(outcome.output)
      : outcome.status === "failed"
        ? `Failed: ${outcome.error.message}`
        : "Cancelled.";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= LAST_STATUS_MAX_LENGTH
    ? line
    : `${line.slice(0, LAST_STATUS_MAX_LENGTH - 1)}…`;
}

/** Body of a `<task_result>` block projected from a definition's `toModelOutput`. */
export function renderModelOutputBody(output: ToolModelOutput): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return JSON.stringify(output.value, null, 2) ?? "null";
    case "content":
      return output.value
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[file: ${part.filename ?? part.mediaType} (${part.mediaType})]`,
        )
        .join("\n");
  }
}

function stringifyOutput(output: JsonValue): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function formatMinute(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16)}Z`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A body cannot close its own block. */
function escapeResultBody(value: string): string {
  return value.replaceAll("</task_result", "&lt;/task_result");
}
