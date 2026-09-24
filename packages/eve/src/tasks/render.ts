import type { ModelMessage } from "ai";

import { truncateHead } from "#execution/sandbox/truncate-output.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskKind, TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import type { ToolModelOutput } from "#tools/model-output.js";

// Every string the model reads about tasks lives in this module.

/** Label prefixing the framework-authored `[Tasks]` note. */
export const TASKS_NOTE_LABEL = "[Tasks]";

/** Idle agents listed in the `[Tasks]` note, most recent first. */
const MAX_IDLE_AGENTS = 10;

const EMPTY_TASKS_NOTE = [
  TASKS_NOTE_LABEL,
  "<tasks>",
  "</tasks>",
  "<idle_agents>",
  "</idle_agents>",
].join("\n");

/** Structured receipt returned to clients for a detached call. */
export interface TaskReceipt {
  readonly status: "working";
  readonly taskId: string;
}

function noun(kind: TaskKind): "agent" | "task" {
  return kind === "agent" ? "agent" : "task";
}

/** Receipt text for a call that started a detached task. */
export function renderStartReceipt(record: Pick<TaskRecord, "id">): string {
  return `Started task ${record.id}. Use task_wait for its result.`;
}

/** Tool result for a call that sent a message to an agent that is still working. */
export function renderSteeringReceipt(record: Pick<TaskRecord, "id">): string {
  return `Sent your message to agent ${record.id}, which is still working. Use task_wait for its result.`;
}

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
 * history, plus idle agents. Returns `undefined` when there is nothing to list.
 */
export function renderTasksNote(records: readonly TaskRecord[]): string | undefined {
  const tasks = records.filter((record) => record.mode === "detached" && !record.delivered);
  const idle = records
    .filter(
      (record) =>
        record.kind === "agent" &&
        record.child !== undefined &&
        record.delivered &&
        (record.status === "completed" ||
          record.status === "failed" ||
          record.status === "cancelled"),
    )
    .toSorted((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, MAX_IDLE_AGENTS);
  if (tasks.length === 0 && idle.length === 0) return undefined;
  const lines = [TASKS_NOTE_LABEL, "<tasks>"];
  for (const task of tasks) {
    lines.push(
      `<task id="${escapeAttribute(task.id)}" name="${escapeAttribute(task.name)}" status="${task.status}" started="${formatMinute(task.startedAt)}"/>`,
    );
  }
  lines.push("</tasks>", "<idle_agents>");
  for (const agent of idle) {
    lines.push(
      `<agent id="${escapeAttribute(agent.id)}" name="${escapeAttribute(agent.name)}">${escapeText(agent.lastStatus ?? "")}</agent>`,
    );
  }
  lines.push("</idle_agents>");
  return lines.join("\n");
}

/** Description of the `agentId` input on every agent tool. */
export const AGENT_ID_PARAMETER_DESCRIPTION =
  "The id of an agent from the latest [Tasks] note or a receipt. An idle agent gets more work in the same child session; an agent that is still working receives this message as a correction to its current work, keeps the output format it was given, and still returns one result. Omit this field (or pass null or an empty string) to start a new agent.";

/** How a model-written workflow program calls agents with `ctx.agent`. */
export const WORKFLOW_PROGRAM_AGENT_CONTRACT =
  "Call ctx.agent(name, { message: string, agentId?: string, outputSchema?: object }). It resolves directly to the child's JSON-serializable output; when outputSchema is provided, the output matches that schema. It does not return an agent metadata wrapper. Use an idle agent's id from the conversation's [Tasks] note to continue that child. The owning agent resolves the target and applies its existing availability and authorization checks.";

/** Output of `task_cancel`. */
export interface TaskCancelOutput {
  readonly status: "cancelled" | "already_finished";
}

export const TASK_CANCEL_DESCRIPTION =
  "Stop a task's current work. That work never reports back; if it already finished, its result is still delivered. Agents stay available afterwards: if the [Tasks] note lists the agent as idle, pass its id as agentId to its tool to give it new work.";

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
  record: Pick<TaskRecord, "id" | "kind" | "name" | "status">,
  waitedMs: number,
): string {
  const choices =
    record.kind === "agent"
      ? `keep the task, pass its id as agentId to ${record.name} to correct it, or stop it with task_cancel`
      : "keep the task or stop it with task_cancel";
  return `A new message arrived, so the wait ended after ${formatDuration(waitedMs)}; ${describeOpenTask(record)}. Read the message and decide whether it changes this work: ${choices}.`;
}

/** The current state of a task a wait ended on before it finished. */
function describeOpenTask(record: Pick<TaskRecord, "id" | "status">): string {
  return record.status === "input_required"
    ? `${record.id} is waiting on a person`
    : `${record.id} is still working`;
}

/** Result of a `task_wait` on an idle agent with nothing new. */
export function renderWaitIdle(record: Pick<TaskRecord, "id" | "name">): string {
  return `${record.id} is idle and has no new result. Pass its id as agentId to ${record.name} to give it more work.`;
}

/** `UNKNOWN_TASK` error message for `task_wait` and `task_cancel`. */
export function renderUnknownTask(taskId: string): string {
  return `No open task "${taskId}" in this session; it may have ended. The latest [Tasks] note lists open tasks.`;
}

/** `TASK_OTHER_PRINCIPAL` error message for a task a different caller started. */
export function renderTaskOtherPrincipal(taskId: string): string {
  return `Task "${taskId}" was started by a different caller, so you can't use it. Start a new one by calling its tool.`;
}

/** `TASK_ALREADY_WAITED` error message for a second `task_wait` on one task in a step. */
export function renderTaskAlreadyWaited(taskId: string): string {
  return `Another task_wait in this step already waits for task "${taskId}"; use that call's result.`;
}

/**
 * Static system block, offered with `task_wait` and `task_cancel` in every
 * session whose agent can start a detached task. With agents, it also
 * explains how to continue or correct one by `agentId`.
 */
export function renderTasksInstruction(options: { readonly agents: boolean }): string {
  const starts = options.agents
    ? "Every agent call and most workflow tool calls start a task and return its id right away"
    : "Most workflow tool calls start a task and return its id right away";
  const choices = options.agents
    ? "keep the tasks, correct an agent by passing its id as agentId to its tool, or stop them with task_cancel"
    : "keep the tasks or stop them with task_cancel";
  const sentences = [
    `${starts}; the task keeps working while you continue.`,
    "When the user needs the answer to continue, wait for it with task_wait. Start independent tasks first, then wait on them in the same step, one task_wait per task.",
    "A result you don't wait for arrives in a <task_result> message.",
    "You cannot end your turn while tasks you started are working; eve waits for them and gives you their results.",
    `A new message interrupts your waits but not your tasks: decide whether it changes the work, then ${choices}.`,
    "Never use sleep to wait for a task.",
  ];
  if (options.agents) {
    sentences.push(
      "Agents stay available after they answer: pass an idle agent's id as agentId to its tool to give it more work in its existing session. Any agent tool can always be called without agentId to start a new agent, even when the [Tasks] note is empty or absent.",
    );
  }
  sentences.push(
    `The latest [Tasks] note lists working tasks${options.agents ? " and idle agents" : ""}; eve adds it whenever the listing changes, and it never needs a reply.`,
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

/** `UNKNOWN_AGENT` error message for an `agentId` that names nothing in the session. */
export function renderUnknownAgent(agentId: string): string {
  return `No agent with id "${agentId}" exists in this session. Omit agentId to start a new agent.`;
}

/** `UNKNOWN_AGENT` error message for an `agentId` that names a workflow task. */
export function renderNotAnAgent(taskId: string): string {
  return `"${taskId}" is a task, not an agent. Use task_cancel to stop it.`;
}

/** `AGENT_MISMATCH` error message for an `agentId` passed to another agent's tool. */
export function renderAgentMismatch(record: Pick<TaskRecord, "id" | "name">): string {
  return `Agent "${record.id}" is a ${record.name} agent. Call the ${record.name} tool to continue it.`;
}

/**
 * `AGENT_BUSY` error for a call that names a working agent it may not send a
 * message to: a `ctx.agent` call (`workflow-caller`), or a model call when a
 * workflow body started the agent's current work (`workflow-owned`). A
 * workflow body awaits the output of the work it started.
 */
export function renderAgentBusy(
  agentId: string,
  reason: "workflow-caller" | "workflow-owned",
): string {
  switch (reason) {
    case "workflow-caller":
      return `Agent "${agentId}" is still working on another call, so a workflow cannot give it more work until it answers. Omit agentId to start a new agent.`;
    case "workflow-owned":
      return `Agent "${agentId}" is working for a workflow tool call, so it cannot take your message until it answers. Omit agentId to start a new agent.`;
  }
}

/**
 * `AGENT_UNREACHABLE` error message. `ended`: the owner knows the agent's
 * session is gone; `gone`: delivery found no session; `temporary`: delivery
 * may succeed on a later call.
 */
export function renderAgentUnreachable(
  agentId: string,
  reason: "ended" | "gone" | "temporary",
): string {
  switch (reason) {
    case "ended":
      return `Agent "${agentId}" can no longer be given more work. Omit agentId to start a new agent.`;
    case "gone":
      return `Agent "${agentId}" is no longer reachable. Omit agentId to start a new agent.`;
    case "temporary":
      return `Agent "${agentId}" is temporarily unreachable. Try again.`;
  }
}

/**
 * `AGENT_OTHER_PRINCIPAL` error for a call that names an agent a different
 * caller started: another user, a schedule, or an app principal. The agent
 * acts with its starter's credentials and keeps their conversation, so only
 * that caller may give it more work or redirect it.
 */
export function renderAgentOtherPrincipal(agentId: string): string {
  return `Agent "${agentId}" was started by a different caller, so it cannot take this message. Omit agentId to start a new agent.`;
}

/**
 * Message for a remote agent whose deployment speaks another task protocol
 * version, or reports none because it runs an older eve: `START_FAILED` at
 * start, `AGENT_UNREACHABLE` for a message to a working agent.
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
  return `Agent "${name}" finished without a reply. If you still need its answer, give it more work with its agentId.`;
}

/** Error for a `ctx.agent` call whose child closed its reply channel without answering. */
export function renderAgentClosedWithoutResult(target: string): string {
  return `Agent "${target}" closed without a result.`;
}

const LAST_STATUS_MAX_LENGTH = 200;

/** One-line summary of an agent's last answer, listed with idle agents in the `[Tasks]` note. */
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
