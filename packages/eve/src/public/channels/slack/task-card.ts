import { createHash } from "node:crypto";

import {
  taskCardView,
  trackTaskCardEvent,
  type TaskCardBlocker,
  type TaskCardTask,
  type TaskCardTurn,
  type TaskCardView,
} from "#channel/task-card.js";
import { contextStorage } from "#context/container.js";
import { ScheduleIdKey } from "#context/keys.js";
import { createLogger, logError } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SlackHandle } from "#public/channels/slack/api.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { truncateMessageText } from "#public/channels/slack/limits.js";
import type { SlackTaskCard } from "#public/channels/slack/renderers.js";
import type {
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackEventContext,
} from "#public/channels/slack/slackChannel.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

const log = createLogger("slack.task-card");

/** A plan block holds at most 50 tasks. */
const MAX_PLAN_ROWS = 50;
const MAX_TITLE_LENGTH = 80;
const MAX_LINE_LENGTH = 100;
/** Unfinished turns eve keeps tracking; the oldest drop first. */
const MAX_TRACKED_TURNS = 20;
const WRITE_RETRY_MS = 1_000;

type SlackTaskStatus = "in_progress" | "complete" | "error";

interface SlackTaskObject {
  details?: BlockKitBlock;
  output?: BlockKitBlock;
  readonly status: SlackTaskStatus;
  readonly task_id: string;
  readonly title: string;
}

/**
 * eve's default task card: a `task_card` block for one task, or a `plan` block
 * for several, and no card for a turn that started none. A settled task shows
 * one line about how it ended. Only a failed task shows as an error: a stopped
 * task, usually one the model cancelled because it no longer needed it, shows
 * as done.
 */
export function renderDefaultSlackTaskCard(view: TaskCardView): SlackTaskCard | null {
  if (view.tasks.length === 0) return null;
  const rows = collapseEarlierRows(view.tasks).map(toSlackTask);
  const title = planTitle(view);
  const blocks: BlockKitBlock[] =
    rows.length === 1
      ? [{ type: "task_card", ...rows[0]! }]
      : [{ type: "plan", tasks: rows, title }];
  const titles = view.tasks.map((task) => task.title).join(", ");
  return { blocks, text: truncateMessageText(`${title}: ${titles}`) };
}

function planTitle(view: TaskCardView): string {
  if (view.state === "blocked") {
    const blocker = view.tasks.find((task) => task.blockedOn !== undefined)?.blockedOn;
    return waitingText(blocker?.kind ?? "input");
  }
  const statuses = view.tasks.map((task) => task.status);
  const total = statuses.length;
  if (view.state === "working") {
    const done = statuses.filter((status) => status !== "working" && status !== "blocked").length;
    return done === 0
      ? `Working on ${countTasks(total)}`
      : `${String(done)} of ${countTasks(total)} done`;
  }
  const failed = statuses.filter((status) => status === "failed").length;
  const finished = `Finished ${countTasks(total)}`;
  return failed === 0 ? finished : `${finished}: ${String(failed)} failed`;
}

function countTasks(count: number): string {
  return count === 1 ? "1 task" : `${String(count)} tasks`;
}

/** Keeps a plan within Slack's cap by folding the oldest settled rows into one. */
function collapseEarlierRows(tasks: readonly TaskCardTask[]): readonly TaskCardTask[] {
  if (tasks.length <= MAX_PLAN_ROWS) return tasks;
  const overflow = tasks.length - (MAX_PLAN_ROWS - 1);
  const folded = new Set(
    tasks
      .filter((task) => task.status !== "working")
      .slice(0, overflow)
      .map((task) => task.id),
  );
  const kept = tasks.filter((task) => !folded.has(task.id));
  if (folded.size === 0) return kept.slice(-MAX_PLAN_ROWS);
  const foldedFailure = tasks.some((task) => folded.has(task.id) && task.status === "failed");
  const earlier: TaskCardTask = {
    id: "earlier",
    kind: "tool",
    name: "earlier",
    startedAt: tasks[0]!.startedAt,
    status: foldedFailure ? "failed" : "completed",
    taskId: "earlier",
    title: `${countTasks(folded.size)} finished earlier`,
  };
  return [earlier, ...kept].slice(-MAX_PLAN_ROWS);
}

function toSlackTask(task: TaskCardTask): SlackTaskObject {
  const slackTask: SlackTaskObject = {
    status: slackStatus(task),
    task_id: slackTaskId(task.id),
    title: truncate(task.title, MAX_TITLE_LENGTH),
  };
  if (task.blockedOn !== undefined) slackTask.details = richText(blockerLine(task.blockedOn));
  const output = outputLine(task);
  if (output !== undefined) slackTask.output = richText(output);
  return slackTask;
}

function slackStatus(task: TaskCardTask): SlackTaskStatus {
  switch (task.status) {
    case "working":
    case "blocked":
      return "in_progress";
    case "completed":
    case "cancelled":
      return "complete";
    case "failed":
      return "error";
  }
}

function outputLine(task: TaskCardTask): string | undefined {
  switch (task.status) {
    case "completed":
      return task.summary;
    case "failed":
      return task.summary === undefined ? "Failed" : `Failed: ${task.summary}`;
    case "cancelled":
      return "Stopped early since it was no longer needed";
    default:
      return undefined;
  }
}

function blockerLine(blocker: TaskCardBlocker): string {
  const waiting = waitingText(blocker.kind);
  return blocker.label === undefined ? waiting : `${waiting}: ${blocker.label}`;
}

function waitingText(kind: TaskCardBlocker["kind"]): string {
  switch (kind) {
    case "approval":
      return "Waiting for approval";
    case "authorization":
      return "Waiting for sign-in";
    case "input":
      return "Waiting for a response";
  }
}

function richText(line: string): BlockKitBlock {
  return {
    elements: [
      {
        elements: [{ text: truncate(line, MAX_LINE_LENGTH), type: "text" }],
        type: "rich_text_section",
      },
    ],
    type: "rich_text",
  };
}

/** Cuts at a word boundary when one is near, so a row doesn't end mid-word. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Slack task ids must be unique in a plan; call ids are, but can carry characters Slack rejects. */
function slackTaskId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-200);
}

/** A turn's tracked calls, and the card eve last wrote for it. */
export interface SlackTaskCardState {
  readonly turn: TaskCardTurn;
  readonly ts?: string;
  readonly fingerprint?: string;
}

const TRACKED_EVENTS = [
  "actions.requested",
  "action.result",
  "task.started",
  "task.settled",
  "input.requested",
  "input.resolved",
  "authorization.required",
  "authorization.completed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
] as const;

type TrackedEvent = (typeof TRACKED_EVENTS)[number];
type TrackedHandler = (
  data: Extract<UnstampedMessageStreamEvent, { readonly type: TrackedEvent }>["data"],
  channel: SlackEventContext,
  ctx: Parameters<NonNullable<SlackChannelInternalEvents["task.started"]>>[2],
) => Promise<void>;

/**
 * Keeps each turn's task card current from the session's own events. It runs
 * around the renderer chain, so the card never depends on which handlers a
 * renderer keeps: eve tracks the turn's calls first, runs the chain's handler,
 * then writes the card `taskCard` returns if it changed.
 */
export function withTaskCards(
  events: SlackChannelInternalEvents,
  taskCard: (view: TaskCardView) => SlackTaskCard | null,
): SlackChannelInternalEvents {
  const wrapped: Partial<Record<TrackedEvent, TrackedHandler>> = {};
  for (const type of TRACKED_EVENTS) {
    const handler = events[type] as TrackedHandler | undefined;
    wrapped[type] = async (data, channel, ctx) => {
      const event = { data, type } as UnstampedMessageStreamEvent;
      const changed = trackTaskCardEvent(
        trackedTurns(channel.state),
        event,
        new Date().toISOString(),
      );
      for (const [turnId, turn] of Object.entries(changed))
        rememberTurn(channel.state, turnId, turn);
      try {
        await handler?.(data, channel, ctx);
      } finally {
        for (const turnId of Object.keys(changed)) await writeTaskCard(channel, turnId, taskCard);
      }
    };
  }
  return { ...events, ...wrapped } as SlackChannelInternalEvents;
}

function trackedTurns(state: SlackChannelState): Readonly<Record<string, TaskCardTurn>> {
  return Object.fromEntries(
    Object.entries(state.taskCards ?? {}).map(([turnId, card]) => [turnId, card.turn]),
  );
}

function rememberTurn(state: SlackChannelState, turnId: string, turn: TaskCardTurn): void {
  const cards = { ...state.taskCards, [turnId]: { ...state.taskCards?.[turnId], turn } };
  const turnIds = Object.keys(cards);
  for (const oldest of turnIds.slice(0, Math.max(0, turnIds.length - MAX_TRACKED_TURNS))) {
    delete cards[oldest];
  }
  state.taskCards = cards;
}

/**
 * Renders the turn's card and posts or updates it, then forgets a finished
 * turn, whose card can't change again. A schedule's session posts only its
 * final reply, and a session without a thread has nowhere to post.
 */
async function writeTaskCard(
  channel: SlackEventContext,
  turnId: string,
  taskCard: (view: TaskCardView) => SlackTaskCard | null,
): Promise<void> {
  const current = channel.state.taskCards?.[turnId];
  if (current === undefined) return;
  const audience = normalizeChannelAudience(channel.state.audience);
  const view = taskCardView(turnId, current.turn, { audience });
  const { channelId, threadTs } = channel.state;
  const scheduled = contextStorage.getStore()?.get(ScheduleIdKey) !== undefined;
  const thread = channelId && threadTs && !scheduled ? { channelId, threadTs } : undefined;
  const card = thread === undefined ? null : renderCard(taskCard, view);
  if (thread !== undefined && card !== null) {
    const fingerprint = createHash("sha256").update(JSON.stringify(card)).digest("base64url");
    if (fingerprint !== current.fingerprint) {
      const ts = await writeCardWithRetry(channel.slack, { ...thread, card, ts: current.ts });
      // Keep a card that failed to land, so the turn's next change writes it again.
      if (ts === undefined) return;
      channel.state.taskCards = {
        ...channel.state.taskCards,
        [turnId]: { fingerprint, ts, turn: current.turn },
      };
    }
  }
  if (view.state === "finished") forgetTurn(channel.state, turnId);
}

function forgetTurn(state: SlackChannelState, turnId: string): void {
  const { [turnId]: _finished, ...cards } = state.taskCards ?? {};
  state.taskCards = cards;
}

/** An authored card that throws leaves that turn's card as it was. */
function renderCard(
  taskCard: (view: TaskCardView) => SlackTaskCard | null,
  view: TaskCardView,
): SlackTaskCard | null {
  try {
    return taskCard(view);
  } catch (error) {
    logError(log, "task card renderer failed", error, { turnId: view.turnId });
    return null;
  }
}

interface CardWrite {
  readonly card: SlackTaskCard;
  readonly channelId: string;
  readonly threadTs: string;
  readonly ts: string | undefined;
}

/**
 * Writes a card, trying once more after a second. A card that still fails
 * keeps its last fingerprint, so the next change writes it again. Never
 * throws: a card is never worth failing the turn over.
 */
async function writeCardWithRetry(
  slack: SlackHandle,
  write: CardWrite,
): Promise<string | undefined> {
  for (const attempt of [1, 2]) {
    try {
      return await writeCard(slack, write);
    } catch (error) {
      logError(log, "task card write failed", error, { attempt });
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_MS));
    }
  }
  return undefined;
}

/** Updates the card in place, or posts it again when someone deleted it. */
async function writeCard(slack: SlackHandle, write: CardWrite): Promise<string> {
  const message = { blocks: write.card.blocks, channel: write.channelId, text: write.card.text };
  if (write.ts !== undefined) {
    const updated = await slack.request("chat.update", { ...message, ts: write.ts });
    if (updated.ok === true) return write.ts;
    if (updated.error !== "message_not_found") throw slackError(updated.error);
  }
  const posted = await slack.request("chat.postMessage", {
    ...message,
    thread_ts: write.threadTs,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (posted.ok !== true) throw slackError(posted.error);
  if (typeof posted.ts !== "string" || posted.ts === "") {
    throw new Error("Slack did not return a ts for the task card.");
  }
  return posted.ts;
}

function slackError(error: string | undefined): Error {
  return new Error(`Slack task card failed: ${error ?? "unknown_error"}`);
}
