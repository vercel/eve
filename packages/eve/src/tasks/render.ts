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

/**
 * Tool result for a call that sent a message to an agent that is still
 * working. A background agent's result arrives later; a waited agent's result
 * goes to the call that is waiting for it.
 */
export function renderSteeringReceipt(record: Pick<TaskRecord, "id" | "mode">): string {
  const sent = `Sent your message to agent ${record.id}, which is still working.`;
  return record.mode === "background"
    ? `${sent} Its result will arrive in a later message.`
    : `${sent} Its result will arrive as the result of the call that started it.`;
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

/**
 * Static system block for agents that can delegate. It is the one
 * explanation of the `[Tasks]` note wherever agents exist; the background
 * block below adds only what background work changes.
 */
export const AGENT_MESSAGING_INSTRUCTION =
  "Agent messaging\nAn agent call waits for the agent to answer, and its answer is the tool result. When the call returns a receipt instead, the agent keeps working in the background and its answer arrives later in a <task_result> message. Agents stay available after they answer. eve adds a note labeled `[Tasks]` to the conversation whenever its listing changes, and the latest note is current. The note is added by eve, not written by the user, and never requires a reply. Its `<tasks>` block lists background work whose result has not arrived yet, with its status, and its `<idle_agents>` block lists each idle agent's id, name, and a summary of its last answer. The note does not limit which agent tools you can call: any agent tool can always be called without `agentId` to start a new agent, including when the note is empty or absent. Pass an idle agent's id as `agentId` to the same agent tool to give that agent more work in its existing session.";

/** Description of the `agentId` input on every agent tool. */
export const AGENT_ID_PARAMETER_DESCRIPTION =
  "The id of an agent from the latest [Tasks] note or a receipt. An idle agent gets more work in the same child session; an agent that is still working receives this message as a correction to its current work, keeps the output format it was given, and still returns one result. Omit this field (or pass null or an empty string) to start a new agent.";

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

/** Description of the `taskIds` input of `task_cancel`. */
export const TASK_CANCEL_IDS_DESCRIPTION =
  "Ids of background agents or tasks, from their receipts or the latest [Tasks] note.";

/** Error message for a `task_cancel` call whose input could not be read. */
export function renderInvalidTaskCancelInput(maxIds: number): string {
  return `task_cancel needs taskIds: a list of 1 to ${String(maxIds)} task or agent ids.`;
}

export const BACKGROUND_PARAMETER_DESCRIPTION =
  "Run in the background and return immediately. The result arrives later in its own message. Use only when the user does not need the answer to continue. Do not poll, sleep, or call again to check on it. To get several answers together, make the calls in the same step without background.";

/**
 * Static system block for sessions that can have background tasks. With
 * agents, {@link AGENT_MESSAGING_INSTRUCTION} already explains the `[Tasks]`
 * note, so this block only adds redirecting a working agent.
 */
export function renderBackgroundTasksInstruction(options: { readonly agents: boolean }): string {
  const rules =
    "A background call returns a receipt right away, and its result arrives later in a <task_result> message. Never poll, sleep, or call again to check on background work. Reply to every result, in one line if it no longer matters.";
  const specific = options.agents
    ? "To redirect an agent that is still working, pass its agentId to its tool with your correction; its one result still arrives later. Use task_cancel to stop a background agent or task."
    : "The latest [Tasks] note lists background tasks until their results arrive; it is added by eve, not written by the user, and never requires a reply. Use task_cancel to stop a background task.";
  return `Background tasks\n${rules} ${specific}`;
}

/**
 * `TOO_MANY_BACKGROUND_TASKS` error message. An agent call can run without
 * `background`; a `detach: true` tool always runs in the background.
 */
export function renderTooManyBackgroundTasks(
  ids: readonly string[],
  limit: number,
  kind: TaskKind,
): string {
  const running = `${limit} background tasks are already running (${ids.join(", ")}).`;
  return kind === "agent"
    ? `${running} Wait for one to report, stop one with task_cancel, or call without background.`
    : `${running} Wait for one to report or stop one with task_cancel, then call this tool again.`;
}

/** Framework continuation for a result turn that ended without a reply. */
export const RESULT_TURN_REPLY_PROMPT =
  "You received the task results above but did not reply. Reply to the user about them now, in one line if they no longer matter.";

/** Error message for a delegated call whose agent session ended before it replied. */
export const AGENT_SESSION_ENDED_MESSAGE = "The agent's session ended before it replied.";

/** Error message for an agent call the owner cancelled. */
export const AGENT_CALL_CANCELLED_MESSAGE = "The agent invocation was cancelled.";

/** `STATE_LOST` error message for a task whose stored record eve could not read. */
export const STATE_LOST_MESSAGE =
  "eve could not read this task's saved state, so its result is lost. Start it again if it is still needed.";

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
 * `AGENT_OTHER_PRINCIPAL` error for a call that names an agent another user
 * started. The agent acts with its starter's credentials and keeps their
 * conversation, so only that user may give it more work or redirect it.
 */
export function renderAgentOtherPrincipal(agentId: string): string {
  return `Agent "${agentId}" belongs to another user, so it cannot take your message. Omit agentId to start a new agent.`;
}

/**
 * `START_FAILED` message for a remote agent whose deployment speaks another
 * task protocol version, or reports none because it runs an older eve.
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
  return `Remote agent "${input.name}" cannot be called: its deployment ${remote}, and this deployment uses version ${String(input.localVersion)}. Upgrade both deployments to the same eve version.`;
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
