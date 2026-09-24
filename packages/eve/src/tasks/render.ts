import { truncateHead } from "#execution/sandbox/truncate-output.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskKind, TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";

// Every string the model reads about tasks lives in this module.

/** Label prefixing the framework-authored `[Tasks]` note. */
export const TASKS_NOTE_LABEL = "[Tasks]";

/** Idle agents listed in the `[Tasks]` note, most recent first. */
const MAX_IDLE_AGENTS = 10;

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
