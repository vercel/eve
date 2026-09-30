import type { ChannelActivityPresenter } from "#channel/activity-presenter.js";
import {
  projectTaskCards,
  type TaskCardBlocker,
  type TaskCardTask,
  type TaskCardView,
} from "#channel/task-card.js";
import { createLogger, logError } from "#internal/logging.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import { truncateMessageText } from "#public/channels/slack/limits.js";
import type { SlackTaskCard } from "#public/channels/slack/renderers.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";

const log = createLogger("slack.task-card");

/** A plan block holds at most 50 tasks. */
const MAX_PLAN_ROWS = 50;
const MAX_TITLE_LENGTH = 80;
const MAX_LINE_LENGTH = 200;

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
 * for several. Rows show what each task is doing now, then one line about how
 * it ended. A stopped task shows as an error, never as a success.
 */
export function renderDefaultSlackTaskCard(view: TaskCardView): SlackTaskCard | null {
  if (view.tasks.length === 0) return null;
  const title = planTitle(view);
  const rows = collapseEarlierRows(view.tasks).map(toSlackTask);
  const blocks: BlockKitBlock[] =
    rows.length === 1
      ? [{ type: "task_card", ...rows[0]! }]
      : [{ type: "plan", tasks: rows, title }];
  const text = truncateMessageText(`${title}: ${view.tasks.map((task) => task.title).join(", ")}`);
  return { blocks, text };
}

function planTitle(view: TaskCardView): string {
  const total = view.tasks.length;
  if (view.state === "blocked") {
    const blocker = view.tasks.find((task) => task.blockedOn !== undefined)?.blockedOn;
    return waitingText(blocker?.kind ?? "input");
  }
  const settled = view.tasks.filter((task) => task.status !== "working").length;
  if (view.state === "working") {
    return settled === 0
      ? `Working on ${countTasks(total)}`
      : `${String(settled)} of ${countTasks(total)} done`;
  }
  const failed = view.tasks.filter((task) => task.status === "failed").length;
  const stopped = view.tasks.filter((task) => task.status === "cancelled").length;
  const outcomes = [
    ...(failed > 0 ? [`${String(failed)} failed`] : []),
    ...(stopped > 0 ? [`${String(stopped)} stopped`] : []),
  ];
  const finished = `Finished ${countTasks(total)}`;
  return outcomes.length === 0 ? finished : `${finished}: ${outcomes.join(", ")}`;
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
      .filter((task) => task.status !== "working" && task.status !== "blocked")
      .slice(0, overflow)
      .map((task) => task.id),
  );
  const kept = tasks.filter((task) => !folded.has(task.id));
  if (folded.size === 0) return kept.slice(-MAX_PLAN_ROWS);
  const earlier: TaskCardTask = {
    id: "earlier",
    kind: "tool",
    name: "earlier",
    startedAt: tasks[0]!.startedAt,
    status: "completed",
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
  const details = task.blockedOn === undefined ? task.activity : blockerDetails(task.blockedOn);
  if (details !== undefined) slackTask.details = richText(details);
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
      return "complete";
    case "failed":
    case "cancelled":
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

function richText(text: string): BlockKitBlock {
  return {
    elements: [
      {
        elements: [{ text: truncate(text, MAX_LINE_LENGTH), type: "text" }],
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
}

/**
 * Posts one task card per root turn in the session's thread and updates it in
 * place as the turn's tasks change. The collector decides when to render; this
 * only writes what changed.
 */
export function createSlackTaskCardPresenter(input: {
  readonly api: SlackTransportOptions | undefined;
  readonly botToken: SlackBotToken | undefined;
  readonly taskCard: (view: TaskCardView) => SlackTaskCard | null;
}): ChannelActivityPresenter {
  return {
    destination(state) {
      return {
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
      const installationTeamId =
        typeof destination["installationTeamId"] === "string"
          ? destination["installationTeamId"]
          : undefined;
      const posted = isPresenterState(state) ? state.cards : {};
      const cards: Record<string, PostedCard> = {};
      for (const view of projectTaskCards(snapshot)) {
        const current = posted[view.turnId];
        const card = renderCard(input.taskCard, view);
        if (card === null) {
          if (current !== undefined) cards[view.turnId] = current;
          continue;
        }
        const fingerprint = JSON.stringify(card);
        if (current?.fingerprint === fingerprint) {
          cards[view.turnId] = current;
          continue;
        }
        const ts = await writeCard({
          api: input.api,
          botToken: input.botToken,
          card,
          channelId,
          installationTeamId,
          threadTs,
          ts: current?.ts,
        });
        cards[view.turnId] = { fingerprint, ts };
      }
      return { cards } satisfies TaskCardPresenterState;
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

async function writeCard(input: {
  readonly api: SlackTransportOptions | undefined;
  readonly botToken: SlackBotToken | undefined;
  readonly card: SlackTaskCard;
  readonly channelId: string;
  readonly installationTeamId: string | undefined;
  readonly threadTs: string;
  readonly ts: string | undefined;
}): Promise<string> {
  const message = { blocks: input.card.blocks, channel: input.channelId, text: input.card.text };
  const response = await callSlackApi({
    api: input.api,
    body:
      input.ts === undefined
        ? { ...message, thread_ts: input.threadTs }
        : { ...message, ts: input.ts },
    botToken: input.botToken,
    context: { teamId: input.installationTeamId },
    operation: input.ts === undefined ? "chat.postMessage" : "chat.update",
  });
  if (response.ok !== true) {
    throw new Error(`Slack task card failed: ${response.error ?? "unknown_error"}`);
  }
  const ts = typeof response.ts === "string" && response.ts !== "" ? response.ts : input.ts;
  if (ts === undefined) throw new Error("Slack did not return a ts for the task card.");
  return ts;
}

function isPresenterState(value: unknown): value is TaskCardPresenterState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { cards?: unknown }).cards === "object"
  );
}
