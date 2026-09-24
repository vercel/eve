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

/** Structured receipt returned to clients for a background call. */
export interface TaskReceipt {
  readonly status: "working";
  readonly taskId: string;
}

function noun(kind: TaskKind): "agent" | "task" {
  return kind === "agent" ? "agent" : "task";
}

/** Receipt text for an explicit `background: true` agent call or a `detach: true` tool. */
export function renderBackgroundReceipt(record: Pick<TaskRecord, "id" | "kind">): string {
  if (record.kind === "agent") {
    return `Agent ${record.id} is working in the background. Its result will arrive in a later message. Do not poll or repeat this work. Continue with anything that does not depend on it; if nothing remains, tell the user briefly what you started and end your turn.`;
  }
  return `Task ${record.id} is working in the background. Its result will arrive in a later message. Do not poll or repeat this work.`;
}

/** Receipt text for a waited call that moved to the background. */
export function renderDetachedReceipt(
  record: Pick<TaskRecord, "id" | "kind">,
  reason: "steer" | "timeout",
): string {
  const as = `${noun(record.kind)} ${record.id}`;
  return reason === "steer"
    ? `A new message arrived, so this call moved to the background as ${as}. Its result will arrive in a later message. Do not poll or repeat this work.`
    : `This call is taking a while, so it moved to the background as ${as}. Its result will arrive in a later message. Do not poll or repeat this work.`;
}

/** Tool result for a call that sent a message to an agent that is still working. */
export function renderSteeringReceipt(record: Pick<TaskRecord, "id">): string {
  return `Sent your message to agent ${record.id}, which is still working. Its result will arrive in a later message.`;
}

/** Tool result for a `sleep` that a steering message ended early. */
export function renderSleepEndedEarly(waitedMs: number): string {
  return `The sleep ended early after ${formatDuration(waitedMs)} because a new message arrived.`;
}

/** One `<task_result>` block per result; foreground and background share one truncation limit. */
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
      return `<task_result id="${escapeAttribute(record.id)}" name="${escapeAttribute(record.name)}" status="${outcome.status}"${code}>\n${escapeResultBody(truncateHead(text).output)}\n</task_result>`;
    })
    .join("\n");
}

/** Default body for a result without a `toModelOutput` projection. */
export function renderOutcomeBody(outcome: TaskOutcome): string {
  switch (outcome.status) {
    case "completed":
      return stringifyOutput(outcome.output);
    case "failed":
      return outcome.error.code === "STATE_LOST"
        ? `${outcome.error.message} Start it again if it is still needed.`
        : outcome.error.message;
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
  const latest = input.messages.findLast(
    (message) =>
      message.role === "user" &&
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
 * The `[Tasks]` note: every background task whose result has not reached
 * history, plus idle agents. Returns `undefined` when there is nothing to list.
 */
export function renderTasksNote(records: readonly TaskRecord[]): string | undefined {
  const tasks = records.filter((record) => record.mode === "background" && !record.delivered);
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

/** Static system block for agents that can delegate. */
export const AGENT_MESSAGING_INSTRUCTION =
  "Agent messaging\nA subagent call runs until the agent answers, and its answer is the tool result. Agents you have already delegated to stay available after they answer. eve adds a note labeled `[Tasks]` to the conversation when that set changes; its `<idle_agents>` block lists each agent's id, name, and a summary of its last answer. The note is added by eve, not written by the user, and never requires a reply. It does not limit which subagent tools you can call: any subagent tool can always be called without `agentId` to start a new agent, including when the note is empty or absent. Pass an idle agent's id as `agentId` to the same subagent tool only to give that agent more work in its existing session.";

/** Description of the `agentId` input on every agent tool. */
export const AGENT_ID_PARAMETER_DESCRIPTION =
  "The id of an idle agent from the latest [Tasks] note, to give it more work in the same child session. Omit this field (or pass null or an empty string) to start a new agent.";

/** How a model-written workflow program calls agents with `ctx.agent`. */
export const WORKFLOW_PROGRAM_AGENT_CONTRACT =
  "Call ctx.agent(name, { message: string, agentId?: string, outputSchema?: object }). It resolves directly to the child's JSON-serializable output; when outputSchema is provided, the output matches that schema. It does not return an agent metadata wrapper. Use an idle agent's id from the conversation's [Tasks] note to continue that child. The owning agent resolves the target and applies its existing availability and authorization checks.";

/** Output of `task_cancel`. */
export interface TaskCancelOutput {
  readonly cancelled: readonly string[];
  readonly alreadyFinished: readonly string[];
  readonly unknown: readonly string[];
}

export const TASK_CANCEL_DESCRIPTION =
  "Stop background agents or tasks by id. A stopped one never reports back. One that already finished is listed in alreadyFinished, and its result is still delivered. A stopped agent stays available: pass its agentId to give it new work.";

export const BACKGROUND_PARAMETER_DESCRIPTION =
  "Run in the background and return immediately. The result arrives later in its own message. Use only when the user does not need the answer to continue. Do not poll, sleep, or call again to check on it. To get several answers together, make the calls in the same step without background.";

/** Static system block for sessions that can have background tasks. */
export const BACKGROUND_TASKS_INSTRUCTION = [
  "Background tasks",
  "A background call returns a receipt right away, and its result arrives later in a <task_result> message. Never poll, sleep, or call again to check on background work. Reply to every result, in one line if it no longer matters. The latest [Tasks] note lists background tasks until their results arrive, plus idle agents; it is added by eve, not written by the user. Pass an agent's agentId to its tool to give it more work or redirect it while it works, and use task_cancel to stop a background agent or task.",
].join("\n");

export function renderTooManyBackgroundTasks(ids: readonly string[], limit: number): string {
  return `${limit} background tasks are already running (${ids.join(", ")}). Wait for one to report, stop one with task_cancel, or call without background.`;
}

/** Framework continuation for a result turn that ended without a reply. */
export const RESULT_TURN_REPLY_PROMPT =
  "You received the task results above but did not reply. Reply to the user about them now, in one line if they no longer matter.";

/** Error message for a delegated call whose agent session ended before it replied. */
export const AGENT_SESSION_ENDED_MESSAGE = "The agent's session ended before it replied.";

/** Error message for an agent call the owner cancelled. */
export const AGENT_CALL_CANCELLED_MESSAGE = "The agent invocation was cancelled.";

/** `TIMED_OUT` error message for a call still working at its time limit. */
export function renderTimedOut(kind: TaskKind): string {
  return `The ${noun(kind)} did not finish within its time limit and was stopped.`;
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

/** `AGENT_BUSY` error message for a call that names an agent still working on an earlier call. */
export function renderAgentBusy(agentId: string): string {
  return `Agent "${agentId}" is still working on an earlier call. Wait for its result before giving it more work.`;
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
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
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
