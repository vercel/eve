import type { ChannelActivityPresenter } from "#channel/activity-presenter.js";
import {
  projectTaskCards,
  type TaskCardBlocker,
  type TaskCardPlanItem,
  type TaskCardStep,
  type TaskCardTask,
  type TaskCardView,
} from "#channel/task-card.js";
import { createLogger, logError } from "#internal/logging.js";
import { waitingOnTasks } from "#public/channels/slack/action-status.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { truncateMessageText, truncateTypingStatus } from "#public/channels/slack/limits.js";
import type { SlackTaskCard } from "#public/channels/slack/renderers.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

const log = createLogger("slack.task-card");

/** A plan block holds at most 50 tasks. */
const MAX_PLAN_ROWS = 50;
const MAX_TITLE_LENGTH = 80;
const MAX_LINE_LENGTH = 200;
/**
 * Slack clears a thread's status after two minutes without a message, so a
 * status set while tasks work is set again before then. The collector renders
 * about every 90 seconds while a task works.
 */
const STATUS_REFRESH_MS = 80_000;

type SlackTaskStatus = "pending" | "in_progress" | "complete" | "error";

interface SlackTaskObject {
  details?: BlockKitBlock;
  output?: BlockKitBlock;
  readonly status: SlackTaskStatus;
  readonly task_id: string;
  readonly title: string;
}

/**
 * eve's default task card: a `task_card` block for one row, or a `plan` block
 * for several. The agent's plan comes first, then one row per task. A working
 * task shows its latest steps, then one line about how it ended. A stopped
 * task shows as an error, never as a success.
 */
export function renderDefaultSlackTaskCard(view: TaskCardView): SlackTaskCard | null {
  const rows = [
    ...view.plan.map((item, index) => planRow(item, index, view.state)),
    ...collapseEarlierRows(view.tasks, MAX_PLAN_ROWS - view.plan.length).map(toSlackTask),
  ];
  if (rows.length === 0) return null;
  const title = planTitle(view);
  const blocks: BlockKitBlock[] =
    rows.length === 1
      ? [{ type: "task_card", ...rows[0]! }]
      : [{ type: "plan", tasks: rows, title }];
  const titles = [...view.plan, ...view.tasks].map((row) => row.title);
  return { blocks, text: truncateMessageText(`${title}: ${titles.join(", ")}`) };
}

function planTitle(view: TaskCardView): string {
  if (view.state === "blocked") {
    const blocker = view.tasks.find((task) => task.blockedOn !== undefined)?.blockedOn;
    return waitingText(blocker?.kind ?? "input");
  }
  const statuses = [...view.plan, ...view.tasks].map((row) => row.status);
  const total = statuses.length;
  if (view.state === "working") {
    const done = statuses.filter((status) => status !== "working" && status !== "pending").length;
    return done === 0
      ? `Working on ${countTasks(total)}`
      : `${String(done)} of ${countTasks(total)} done`;
  }
  const failed = statuses.filter((status) => status === "failed").length;
  const stopped = statuses.filter((status) => status === "cancelled").length;
  const outcomes: string[] = [];
  if (failed > 0) outcomes.push(`${String(failed)} failed`);
  if (stopped > 0) outcomes.push(`${String(stopped)} stopped`);
  const finished = `Finished ${countTasks(total)}`;
  return outcomes.length === 0 ? finished : `${finished}: ${outcomes.join(", ")}`;
}

function countTasks(count: number): string {
  return count === 1 ? "1 task" : `${String(count)} tasks`;
}

/** An item the turn left unfinished stops spinning once the turn ends. */
function planRow(
  item: TaskCardPlanItem,
  index: number,
  state: TaskCardView["state"],
): SlackTaskObject {
  const status: SlackTaskStatus =
    item.status === "completed"
      ? "complete"
      : item.status === "failed"
        ? "error"
        : item.status === "working" && state !== "finished"
          ? "in_progress"
          : "pending";
  return {
    status,
    task_id: `plan_${String(index)}`,
    title: truncate(item.title, MAX_TITLE_LENGTH),
  };
}

/** Keeps a plan within Slack's cap by folding the oldest settled rows into one. */
function collapseEarlierRows(
  tasks: readonly TaskCardTask[],
  limit: number,
): readonly TaskCardTask[] {
  if (tasks.length <= limit) return tasks;
  const overflow = tasks.length - (limit - 1);
  const folded = new Set(
    tasks
      .filter((task) => task.status !== "working" && task.status !== "blocked")
      .slice(0, overflow)
      .map((task) => task.id),
  );
  const kept = tasks.filter((task) => !folded.has(task.id));
  if (folded.size === 0) return kept.slice(-limit);
  const earlier: TaskCardTask = {
    id: "earlier",
    kind: "tool",
    name: "earlier",
    startedAt: tasks[0]!.startedAt,
    status: "completed",
    steps: [],
    taskId: "earlier",
    title: `${countTasks(folded.size)} finished earlier`,
  };
  return [earlier, ...kept].slice(-limit);
}

function toSlackTask(task: TaskCardTask): SlackTaskObject {
  const slackTask: SlackTaskObject = {
    status: slackStatus(task),
    task_id: slackTaskId(task.id),
    title: truncate(task.title, MAX_TITLE_LENGTH),
  };
  const details =
    task.blockedOn !== undefined
      ? [blockerDetails(task.blockedOn)]
      : task.status === "working"
        ? task.steps.map(stepLine)
        : [];
  if (details.length > 0) slackTask.details = richText(details);
  const output = outputLine(task);
  if (output !== undefined) slackTask.output = richText([output]);
  return slackTask;
}

function slackStatus(task: TaskCardTask): SlackTaskStatus {
  switch (task.status) {
    case "working":
    case "blocked":
      return "in_progress";
    case "completed":
      return "complete";
    case "failed":
    case "cancelled":
      return "error";
  }
}

function stepLine(step: TaskCardStep): string {
  const label = truncate(step.label, MAX_TITLE_LENGTH);
  switch (step.status) {
    case "working":
      return `${label}...`;
    case "completed":
      return `✓ ${label}`;
    case "failed":
      return `✗ ${label}`;
    case "cancelled":
      return `– ${label}`;
  }
}

function outputLine(task: TaskCardTask): string | undefined {
  switch (task.status) {
    case "completed":
      return task.summary;
    case "failed":
      return task.summary === undefined ? "Failed" : `Failed: ${task.summary}`;
    case "cancelled":
      return "Stopped";
    default:
      return undefined;
  }
}

function blockerDetails(blocker: TaskCardBlocker): string {
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

function richText(lines: readonly string[]): BlockKitBlock {
  return {
    elements: [
      {
        elements: [
          { text: lines.map((line) => truncate(line, MAX_LINE_LENGTH)).join("\n"), type: "text" },
        ],
        type: "rich_text_section",
      },
    ],
    type: "rich_text",
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Slack task ids must be unique in a plan; row ids are, but carry characters Slack rejects. */
function slackTaskId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-200);
}

interface PostedCard {
  readonly fingerprint: string;
  readonly ts: string;
}

interface TaskCardPresenterState {
  readonly cards: Readonly<Record<string, PostedCard>>;
  /** When eve last set the waiting status, while tasks work. */
  readonly statusAt?: number;
}

interface SlackDestination {
  readonly api: SlackTransportOptions | undefined;
  readonly botToken: SlackBotToken | undefined;
  readonly channelId: string;
  readonly teamId: string | undefined;
  readonly threadTs: string;
}

/**
 * Posts one task card per root turn in the session's thread and updates it in
 * place as the turn changes. The collector decides when to render; this only
 * writes what changed, and keeps the waiting status alive while tasks work.
 */
export function createSlackTaskCardPresenter(input: {
  readonly api: SlackTransportOptions | undefined;
  readonly botToken: SlackBotToken | undefined;
  readonly taskCard: (view: TaskCardView) => SlackTaskCard | null;
}): ChannelActivityPresenter {
  return {
    destination(state) {
      return {
        audience: normalizeChannelAudience(state?.["audience"]),
        channelId: state?.["channelId"] ?? null,
        installationTeamId: state?.["installationTeamId"] ?? null,
        threadTs: state?.["threadTs"] ?? null,
      };
    },
    async render({ destination, snapshot, state }) {
      const channelId = destination["channelId"];
      const threadTs = destination["threadTs"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "") {
        return state;
      }
      const slack: SlackDestination = {
        api: input.api,
        botToken: input.botToken,
        channelId,
        teamId:
          typeof destination["installationTeamId"] === "string"
            ? destination["installationTeamId"]
            : undefined,
        threadTs,
      };
      const previous = isPresenterState(state) ? state : { cards: {} };
      const views = projectTaskCards(snapshot, {
        audience: normalizeChannelAudience(destination["audience"]),
      });
      const cards: Record<string, PostedCard> = {};
      for (const view of views) {
        const current = previous.cards[view.turnId];
        const card = renderCard(input.taskCard, view);
        const fingerprint = card === null ? undefined : JSON.stringify(card);
        if (card === null || current?.fingerprint === fingerprint) {
          if (current !== undefined) cards[view.turnId] = current;
          continue;
        }
        try {
          const ts = await writeCard(slack, card, current?.ts);
          cards[view.turnId] = { fingerprint: fingerprint!, ts };
        } catch (error) {
          // Keep the card as it was, so the next render writes it again
          // without posting the cards that did land a second time.
          logError(log, "task card write failed", error, { turnId: view.turnId });
          if (current !== undefined) cards[view.turnId] = current;
        }
      }
      const next: { cards: Record<string, PostedCard>; statusAt?: number } = { cards };
      const statusAt = await refreshWaitingStatus(slack, views, previous.statusAt);
      if (statusAt !== undefined) next.statusAt = statusAt;
      return next satisfies TaskCardPresenterState;
    },
  };
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

/**
 * Sets the waiting status again once it is about to expire. The session sets
 * it first when the turn waits; this only keeps it from lapsing.
 */
async function refreshWaitingStatus(
  slack: SlackDestination,
  views: readonly TaskCardView[],
  statusAt: number | undefined,
): Promise<number | undefined> {
  const working = views
    .filter((view) => view.state === "working")
    .flatMap((view) => view.tasks.filter((task) => task.status === "working"))
    .map((task) => task.name);
  if (working.length === 0) return undefined;
  const now = Date.now();
  if (statusAt === undefined) return now;
  if (now - statusAt < STATUS_REFRESH_MS) return statusAt;
  const status = truncateTypingStatus(waitingOnTasks(working));
  const response = await callSlack(slack, "assistant.threads.setStatus", {
    channel_id: slack.channelId,
    loading_messages: [status],
    status,
    thread_ts: slack.threadTs,
  }).catch((error: unknown) => {
    logError(log, "waiting status refresh failed", error);
    return undefined;
  });
  if (response !== undefined && response.ok !== true) {
    log.warn("assistant.threads.setStatus returned not-ok", { error: response.error });
  }
  return now;
}

/** Updates the card in place, or posts it again when someone deleted it. */
async function writeCard(
  slack: SlackDestination,
  card: SlackTaskCard,
  ts: string | undefined,
): Promise<string> {
  const message = { blocks: card.blocks, channel: slack.channelId, text: card.text };
  if (ts !== undefined) {
    const updated = await callSlack(slack, "chat.update", { ...message, ts });
    if (updated.ok === true) return ts;
    if (updated.error !== "message_not_found") throw slackError(updated.error);
  }
  const posted = await callSlack(slack, "chat.postMessage", {
    ...message,
    thread_ts: slack.threadTs,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (posted.ok !== true) throw slackError(posted.error);
  if (typeof posted.ts !== "string" || posted.ts === "") {
    throw new Error("Slack did not return a ts for the task card.");
  }
  return posted.ts;
}

function callSlack(slack: SlackDestination, operation: string, body: Record<string, unknown>) {
  return callSlackApi({
    api: slack.api,
    body,
    botToken: slack.botToken,
    context: { teamId: slack.teamId },
    operation,
  });
}

function slackError(error: string | undefined): Error {
  return new Error(`Slack task card failed: ${error ?? "unknown_error"}`);
}

function isPresenterState(value: unknown): value is TaskCardPresenterState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { cards?: unknown }).cards === "object"
  );
}
