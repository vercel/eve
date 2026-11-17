import { createHash } from "node:crypto";

import { taskCards, type TaskCard } from "#channel/task-card.js";
import {
  callLabel,
  callOutputSource,
  callState,
  openInteractions,
} from "#protocol/session-projection/selectors.js";
import type { CallRow, InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import { sessionTables } from "#protocol/session-projection/session-view.js";

type RenderCard = Omit<TaskCard, "view" | "calls"> & {
  readonly view: SessionView;
  readonly calls: readonly CallRow[];
};
import type { JsonObject, JsonValue } from "#shared/json.js";
import { firstSentence, normalizePresentationText } from "#shared/presentation-text.js";
import { contextStorage } from "#context/container.js";
import { ScheduleIdKey } from "#context/keys.js";
import { createLogger, logError } from "#internal/logging.js";
import type { SlackHandle } from "#public/channels/slack/api.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { slackThreadTsParam } from "#public/channels/slack/code-channel.js";
import { truncateMessageText } from "#public/channels/slack/limits.js";
import type { SlackCardMessage } from "#public/channels/slack/renderers.js";
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

const MAX_PLAN_ROWS = 50;
const MAX_NAMED_AGENTS = 3;
const MIN_SHOWN_DURATION_MS = 1_000;
const MAX_TITLE_LENGTH = 80;
const MAX_LINE_LENGTH = 100;
const MAX_BLOCKER_LABEL_LENGTH = 200;
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

export function renderDefaultSlackTaskCard(snapshot: TaskCard): SlackCardMessage | null {
  const view = sessionTables(snapshot.view);
  const card: RenderCard = {
    ...snapshot,
    view,
    calls: snapshot.calls.flatMap((entry) => view.calls[entry.callId] ?? []),
  };
  const tasks = card.calls.filter((row) => row.taskId !== undefined);
  if (tasks.length === 0) return null;
  const { earlier, rows } = collapseEarlierRows(card.view, tasks);
  const title = planTitle(card, tasks);
  const slackRows = [
    ...(earlier === undefined ? [] : [earlier]),
    ...rows.map((row) => toSlackTask(card, row)),
  ];
  const block_id = slackBlockId(card.turnId);
  const blocks: BlockKitBlock[] =
    slackRows.length === 1
      ? [{ block_id, type: "task_card", ...slackRows[0]! }]
      : [{ block_id, type: "plan", tasks: slackRows, title }];
  const titles = tasks.map((row) => callLabel(row)).join(", ");
  return { blocks, text: truncateMessageText(`${title}: ${titles}`) };
}

function planTitle(card: RenderCard, tasks: readonly CallRow[]): string {
  const { view } = card;
  if (card.state === "blocked") {
    const asked = tasks.flatMap((row) => openInteractions(view, { about: { callId: row.callId } }));
    return waitingText(asked[0]?.request.kind);
  }
  const total = tasks.length;
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

function isInterrupted(view: SessionView, row: CallRow): boolean {
  return callState(view, row.callId) === "cancelled" && row.reason !== "task-cancel";
}

function countTasks(count: number): string {
  return count === 1 ? "1 task" : `${String(count)} tasks`;
}

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

function toSlackTask(card: RenderCard, row: CallRow): SlackTaskObject {
  const { view } = card;
  const slackTask: SlackTaskObject = {
    status: slackStatus(view, row),
    task_id: slackTaskId(row.callId),
    title: truncate(callLabel(row), MAX_TITLE_LENGTH),
  };
  const asked = openInteractions(view, { about: { callId: row.callId } }).at(-1);
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

function outputLine(card: RenderCard, row: CallRow): string | undefined {
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

function blockerLine(card: RenderCard, asked: InteractionRow): string {
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

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

export function withTaskCards(
  events: SlackChannelInternalEvents,
  taskCard: (card: TaskCard) => SlackCardMessage | null,
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
        for (const turnId of turnIds)
          await writeTaskCards(channel, sessionTables(view), turnId, taskCard);
      }
    },
  };
}

async function writeTaskCards(
  channel: SlackEventContext,
  view: SessionView,
  turnId: string,
  taskCard: (card: TaskCard) => SlackCardMessage | null,
): Promise<void> {
  if (view.turns[turnId] === undefined) return;
  const audience = normalizeChannelAudience(channel.state.audience);
  const cards = taskCards(view, turnId, audience);
  const since = channel.state.taskCards?.[turnId]?.since ?? 0;
  for (const card of cards) {
    if (card.since < since) continue;
    if (card.since > (channel.state.taskCards?.[turnId]?.since ?? 0)) {
      rememberCard(channel.state, turnId, { since: card.since });
    }
    await writeChangedCard(channel, turnId, card, taskCard);
  }
  if (cards.at(-1)?.state === "finished") forgetTurn(channel.state, turnId);
}

async function writeChangedCard(
  channel: SlackEventContext,
  turnId: string,
  view: TaskCard,
  taskCard: (card: TaskCard) => SlackCardMessage | null,
): Promise<void> {
  const { channelId, codeChannel } = channel.state;
  const threadTs = (codeChannel ? channel.state.replyThreadTs : channel.state.threadTs) ?? "";
  const scheduled = contextStorage.getStore()?.get(ScheduleIdKey) !== undefined;
  if (!channelId || !(threadTs || codeChannel) || scheduled) return;
  const card = renderCard(taskCard, view);
  if (card === null) return;
  const current = channel.state.taskCards?.[turnId] ?? {};
  const fingerprint = createHash("sha256").update(JSON.stringify(card)).digest("base64url");
  if (fingerprint === current.fingerprint) return;
  const ts = await writeCardWithRetry(channel.slack, { card, channelId, threadTs, ts: current.ts });
  if (ts === undefined) return;
  rememberCard(channel.state, turnId, { ...current, fingerprint, ts });
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

function renderCard(
  taskCard: (card: TaskCard) => SlackCardMessage | null,
  view: TaskCard,
): SlackCardMessage | null {
  try {
    return taskCard(view);
  } catch (error) {
    logError(log, "task card renderer failed", error, { turnId: view.turnId });
    return null;
  }
}

interface CardWrite {
  readonly card: SlackCardMessage;
  readonly channelId: string;
  readonly threadTs: string;
  readonly ts: string | undefined;
}

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

async function writeCard(slack: SlackHandle, write: CardWrite): Promise<string> {
  const message = { blocks: write.card.blocks, channel: write.channelId, text: write.card.text };
  if (write.ts !== undefined) {
    const updated = await slack.request("chat.update", { ...message, ts: write.ts });
    if (updated.ok === true) return write.ts;
    if (updated.error !== "message_not_found") throw slackError(updated.error);
  }
  const posted = await slack.request("chat.postMessage", {
    ...message,
    thread_ts: slackThreadTsParam(write.threadTs),
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
