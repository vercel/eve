import { createHash } from "node:crypto";

import { taskCards, type TaskCard } from "#channel/task-card.js";
import {
  callLabel,
  callOutputSource,
  callState,
  waiting,
} from "#protocol/session-projection/selectors.js";
import type { CallRow, InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { firstSentence, normalizePresentationText } from "#shared/presentation-text.js";
import { contextStorage } from "#context/container.js";
import { ScheduleIdKey } from "#context/keys.js";
import { createLogger, logError } from "#internal/logging.js";
import type { SlackHandle } from "#public/channels/slack/api.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { truncateMessageText } from "#public/channels/slack/limits.js";
import type { SlackTaskCard } from "#public/channels/slack/renderers.js";
import { restoreStatus } from "#public/channels/slack/thread-status.js";
import type {
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackEventContext,
} from "#public/channels/slack/slackChannel.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { displayName } from "#protocol/session-projection/display-name.js";
import { formatDuration } from "#shared/format-duration.js";
import { AGENT_TOOL_NAME } from "#tools/framework/agent-contract.js";

const log = createLogger("slack.task-card");

/** A plan block holds at most 50 tasks. */
const MAX_PLAN_ROWS = 50;
/** A plan title names at most this many agents before it counts tasks instead. */
const MAX_NAMED_AGENTS = 3;
/** Shorter work says nothing useful about time, so rows leave it out. */
const MIN_SHOWN_DURATION_MS = 1_000;
const MAX_TITLE_LENGTH = 80;
const MAX_LINE_LENGTH = 100;
const MAX_BLOCKER_LABEL_LENGTH = 200;
/** Unfinished turns whose cards eve keeps; the oldest drop first. */
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
 * one line about how it ended and how long it took. A task the model cancelled
 * with `eve__task_cancel` shows as done, since it no longer needed the work; a
 * failed task, or one stopped any other way, shows as an error.
 */
export function renderDefaultSlackTaskCard(card: TaskCard): SlackTaskCard | null {
  const tasks = card.calls.filter((row) => row.taskId !== undefined);
  if (tasks.length === 0) return null;
  const { earlier, rows } = collapseEarlierRows(card.view, tasks);
  const title = planTitle(card, tasks);
  const slackRows = [
    ...(earlier === undefined ? [] : [earlier]),
    ...rows.map((row) => toSlackTask(card, row)),
  ];
  // Slack keeps the rows a reader expanded only while the block id stays the same.
  const block_id = slackBlockId(card.turnId);
  const blocks: BlockKitBlock[] =
    slackRows.length === 1
      ? [{ block_id, type: "task_card", ...slackRows[0]! }]
      : [{ block_id, type: "plan", tasks: slackRows, title }];
  const titles = tasks.map((row) => callLabel(row)).join(", ");
  return { blocks, text: truncateMessageText(`${title}: ${titles}`) };
}

function planTitle(card: TaskCard, tasks: readonly CallRow[]): string {
  const { view } = card;
  if (card.state === "blocked") {
    const asked = tasks.flatMap((row) => waiting(view, { callId: row.callId })?.interactions ?? []);
    return waitingText(asked[0]?.request.kind);
  }
  const total = tasks.length;
  // One task renders as a `task_card` without a plan title, so naming it there
  // would only repeat its row title in the notification text.
  const names = (subset: readonly CallRow[]) => (total > 1 ? agentNames(view, subset) : undefined);
  if (card.state === "working") {
    const working = tasks.filter((row) => row.status !== "settled");
    const done = total - working.length;
    if (done === 0) {
      const asking = names(tasks);
      return asking === undefined ? `Working on ${countTasks(total)}` : `Asking ${asking}`;
    }
    const progress = `${String(done)} of ${countTasks(total)} done`;
    const waitingOn = names(working);
    return waitingOn === undefined ? progress : `Waiting on ${waitingOn} · ${progress}`;
  }
  const failed = tasks.filter((row) => failedTask(view, row)).length;
  const stopped = tasks.filter((row) => isInterrupted(view, row)).length;
  const outcomes: string[] = [];
  if (failed > 0) outcomes.push(`${String(failed)} failed`);
  if (stopped > 0) outcomes.push(`${String(stopped)} stopped`);
  const took = turnDuration(tasks);
  const finished = `Finished ${countTasks(total)}${took === undefined ? "" : ` in ${took}`}`;
  return outcomes.length === 0 ? finished : `${finished}: ${outcomes.join(", ")}`;
}

/**
 * `d0`, `d0 and sre`, or `d0, sre, and index` when every task is a call to a
 * named agent. A call to the agent's own copy, a tool task, or more than three
 * agents falls back to a count.
 */
function agentNames(view: SessionView, tasks: readonly CallRow[]): string | undefined {
  const agent = (row: CallRow) =>
    (row.taskId === undefined ? undefined : view.tasks[row.taskId]?.kind) ?? row.capability.kind;
  if (tasks.some((row) => agent(row) !== "agent" || row.capability.name === AGENT_TOOL_NAME)) {
    return undefined;
  }
  const names = [...new Set(tasks.map((row) => displayName(row.capability.name)))];
  if (names.length === 0 || names.length > MAX_NAMED_AGENTS) return undefined;
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)!}`;
}

/** From the first task's start to the last one's end. */
function turnDuration(tasks: readonly CallRow[]): string | undefined {
  const ends = tasks.flatMap((row) => (row.endedAt === undefined ? [] : [Date.parse(row.endedAt)]));
  if (ends.length === 0) return undefined;
  const start = Math.min(...tasks.map((row) => Date.parse(row.startedAt)));
  return shownDuration(Math.max(...ends) - start);
}

function taskDuration(row: CallRow): string | undefined {
  if (row.endedAt === undefined) return undefined;
  return shownDuration(Date.parse(row.endedAt) - Date.parse(row.startedAt));
}

function shownDuration(ms: number): string | undefined {
  return Number.isFinite(ms) && ms >= MIN_SHOWN_DURATION_MS ? formatDuration(ms) : undefined;
}

function failedTask(view: SessionView, row: CallRow): boolean {
  const state = callState(view, row.callId);
  return state === "failed" || state === "rejected";
}

/** A task stopped before it finished for any reason but the model's own `eve__task_cancel`. */
function isInterrupted(view: SessionView, row: CallRow): boolean {
  return callState(view, row.callId) === "cancelled" && row.reason !== "task-cancel";
}

function countTasks(count: number): string {
  return count === 1 ? "1 task" : `${String(count)} tasks`;
}

/** Keeps a plan within Slack's cap by folding the oldest settled rows into one. */
function collapseEarlierRows(
  view: SessionView,
  tasks: readonly CallRow[],
): { readonly earlier?: SlackTaskObject; readonly rows: readonly CallRow[] } {
  if (tasks.length <= MAX_PLAN_ROWS) return { rows: tasks };
  const overflow = tasks.length - (MAX_PLAN_ROWS - 1);
  const folded = tasks.filter((row) => row.status === "settled").slice(0, overflow);
  const foldedIds = new Set(folded.map((row) => row.callId));
  const kept = tasks.filter((row) => !foldedIds.has(row.callId));
  if (folded.length === 0) return { rows: kept.slice(-MAX_PLAN_ROWS) };
  const failure = folded.some((row) => failedTask(view, row) || isInterrupted(view, row));
  const earlier: SlackTaskObject = {
    status: failure ? "error" : "complete",
    task_id: "earlier",
    title: truncate(`${countTasks(folded.length)} finished earlier`, MAX_TITLE_LENGTH),
  };
  return { earlier, rows: kept.slice(-(MAX_PLAN_ROWS - 1)) };
}

function toSlackTask(card: TaskCard, row: CallRow): SlackTaskObject {
  const { view } = card;
  const slackTask: SlackTaskObject = {
    status: slackStatus(view, row),
    task_id: slackTaskId(row.callId),
    title: truncate(callLabel(row), MAX_TITLE_LENGTH),
  };
  const asked = waiting(view, { callId: row.callId })?.interactions.at(-1);
  if (asked !== undefined) slackTask.details = richText(blockerLine(card, asked));
  const output = outputLine(card, row);
  if (output !== undefined) slackTask.output = richText(output);
  return slackTask;
}

function slackStatus(view: SessionView, row: CallRow): SlackTaskStatus {
  switch (callState(view, row.callId)) {
    case "completed":
      return "complete";
    case "cancelled":
      return isInterrupted(view, row) ? "error" : "complete";
    case "failed":
    case "rejected":
      return "error";
    default:
      return "in_progress";
  }
}

function outputLine(card: TaskCard, row: CallRow): string | undefined {
  const { view } = card;
  const took = taskDuration(row);
  switch (callState(view, row.callId)) {
    case "completed": {
      const summary = brief(resultText(callOutputSource(view, row.callId)?.output ?? row.output));
      if (took === undefined) return summary;
      const done = `Done in ${took}`;
      return summary === undefined ? done : `${done}: ${summary}`;
    }
    case "failed":
    case "rejected": {
      const failed = took === undefined ? "Failed" : `Failed after ${took}`;
      // An error can say what the task was working on: only a private conversation reads it.
      const summary = card.audience === "private" ? brief(row.error?.message) : undefined;
      return summary === undefined ? failed : `${failed}: ${summary}`;
    }
    case "cancelled":
      return stoppedLine(row.reason);
    default:
      return undefined;
  }
}

function stoppedLine(reason: CallRow["reason"]): string {
  switch (reason) {
    case "task-cancel":
      return "Stopped early since it was no longer needed";
    case "turn-cancelled":
      return "Stopped by request";
    case "turn-ended":
      return "Stopped when the turn ended";
    default:
      return "Stopped";
  }
}

/** What a request asks; its prompt or the connection's name only in a private conversation. */
function blockerLine(card: TaskCard, asked: InteractionRow): string {
  const { request } = asked;
  const waitingOn = waitingText(request.kind);
  if (card.audience !== "private") return waitingOn;
  const text =
    request.kind === "sign-in"
      ? (request.signIn?.displayName ?? request.signIn?.name ?? request.prompt)
      : request.prompt;
  const label = text === undefined ? "" : normalizePresentationText(text);
  return label === "" ? waitingOn : `${waitingOn}: ${label.slice(0, MAX_BLOCKER_LABEL_LENGTH)}`;
}

function waitingText(kind: InteractionRow["request"]["kind"] | undefined): string {
  switch (kind) {
    case "approval":
      return "Waiting for approval";
    case "sign-in":
      return "Waiting for sign-in";
    default:
      return "Waiting for a response";
  }
}

/** The text a result leads with: a string result, or an agent reply's message. */
function resultText(output: JsonValue | undefined): unknown {
  if (typeof output === "string") return output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const fields = output as JsonObject;
  return fields.message ?? fields.text ?? fields.summary;
}

function brief(value: unknown): string | undefined {
  return typeof value === "string" ? firstSentence(value) : undefined;
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

function slackBlockId(turnId: string): string {
  return `eve_task_card_${slackTaskId(turnId)}`;
}

/** The card message eve last wrote for a turn: the card that begins at `since`. */
export interface SlackTaskCardState {
  readonly ts?: string;
  readonly fingerprint?: string;
  /** Where the card it shows begins; absent for the turn's first. */
  readonly since?: number;
}

/**
 * Keeps each turn's task cards current from the session's tables, once per commit. It runs after
 * the renderer chain's own `committed`, so the card never depends on which handlers a renderer
 * keeps, and writes each card `taskCard` returns if it changed.
 */
export function withTaskCards(
  events: SlackChannelInternalEvents,
  taskCard: (card: TaskCard) => SlackTaskCard | null,
): SlackChannelInternalEvents {
  const committed = events.committed;
  return {
    ...events,
    async committed(line, ctx) {
      try {
        await committed?.(line, ctx);
      } finally {
        const { channel, view } = ctx;
        const turnIds = new Set([
          ...line.facts.flatMap((fact) => fact.scope?.turnId ?? []),
          ...Object.keys(channel.state.taskCards ?? {}),
        ]);
        for (const turnId of turnIds) await writeTaskCards(channel, view, turnId, taskCard);
      }
    },
  };
}

/**
 * Writes the turn's cards from the one its message shows on: that card as it now stands, then
 * each later one as a new message, so a turn the caller kept talking to doesn't add its next tasks
 * to a card far up the thread. A turn whose latest card finished is forgotten, since its cards
 * can't change again; one the tables no longer hold is left as last written. A schedule's session
 * posts only its final reply, and a session without a thread has nowhere to post.
 */
async function writeTaskCards(
  channel: SlackEventContext,
  view: SessionView,
  turnId: string,
  taskCard: (card: TaskCard) => SlackTaskCard | null,
): Promise<void> {
  if (view.turns[turnId] === undefined) return;
  const audience = normalizeChannelAudience(channel.state.audience);
  const cards = taskCards(view, turnId, audience);
  const since = channel.state.taskCards?.[turnId]?.since ?? 0;
  for (const card of cards) {
    if (card.since < since) continue;
    // No `ts`: a later card posts a new message, even if the last write of the one before failed.
    if (card.since > (channel.state.taskCards?.[turnId]?.since ?? 0)) {
      rememberCard(channel.state, turnId, { since: card.since });
    }
    await writeChangedCard(channel, turnId, card, taskCard);
  }
  if (cards.at(-1)?.state === "finished") forgetTurn(channel.state, turnId);
}

/** Posts or updates a card unless it reads as last written. */
async function writeChangedCard(
  channel: SlackEventContext,
  turnId: string,
  view: TaskCard,
  taskCard: (card: TaskCard) => SlackTaskCard | null,
): Promise<void> {
  const { channelId, threadTs } = channel.state;
  const scheduled = contextStorage.getStore()?.get(ScheduleIdKey) !== undefined;
  if (!channelId || !threadTs || scheduled) return;
  const card = renderCard(taskCard, view);
  if (card === null) return;
  const current = channel.state.taskCards?.[turnId] ?? {};
  const fingerprint = createHash("sha256").update(JSON.stringify(card)).digest("base64url");
  if (fingerprint === current.fingerprint) return;
  const ts = await writeCardWithRetry(channel.slack, { card, channelId, threadTs, ts: current.ts });
  // A card that failed to land keeps its last fingerprint, so the turn's next change writes it.
  if (ts === undefined) return;
  rememberCard(channel.state, turnId, { ...current, fingerprint, ts });
  // Slack clears the thread status when the app posts, but the turn works on.
  if (ts !== current.ts && view.state === "working") await restoreStatus(channel);
}

function rememberCard(state: SlackChannelState, turnId: string, card: SlackTaskCardState): void {
  const cards = { ...state.taskCards, [turnId]: card };
  const turnIds = Object.keys(cards);
  for (const oldest of turnIds.slice(0, Math.max(0, turnIds.length - MAX_TRACKED_TURNS))) {
    delete cards[oldest];
  }
  state.taskCards = cards;
}

function forgetTurn(state: SlackChannelState, turnId: string): void {
  const { [turnId]: _finished, ...cards } = state.taskCards ?? {};
  state.taskCards = cards;
}

/** An authored card that throws leaves that turn's card as it was. */
function renderCard(
  taskCard: (card: TaskCard) => SlackTaskCard | null,
  view: TaskCard,
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
