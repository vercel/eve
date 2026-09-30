import { createHash } from "node:crypto";

import type { ChannelAdapterContext } from "#channel/adapter.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import {
  attachChannelRenderLane,
  type ChannelRenderLane,
  type ChannelRenderResult,
} from "#channel/render-lane.js";
import {
  agentSessions,
  taskCardAgentWork,
  taskCardView,
  trackTaskCardEvent,
  workingAgentSessions,
  type TaskCardAgentCall,
  type TaskCardAgentWork,
  type TaskCardBlocker,
  type TaskCardTask,
  type TaskCardTurn,
  type TaskCardView,
} from "#channel/task-card.js";
import { contextStorage } from "#context/container.js";
import { ScheduleIdKey } from "#context/keys.js";
import { readSessionEvents } from "#execution/read-session-events.js";
import { MAX_WORKING_TASKS } from "#execution/tasks/table.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  AgentStartedStreamEvent,
  MessageStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
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
/** Turns eve keeps tracking; the oldest drop first. */
const MAX_TRACKED_TURNS = 20;
/**
 * Finished turns kept so the render lane writes their last card; the oldest drop
 * first. The lane renders after every committed step, so a turn would have to
 * be followed by this many finished turns within one render to lose its card.
 */
const MAX_FINISHED_TURNS = 5;
/** A failed card write is tried again after this long within the render. */
const WRITE_RETRY_MS = 1_000;
/**
 * A card whose writes keep failing is tried again in later renders, this long
 * after the first failure and doubling, until it has failed this many
 * renders; its next change starts over. A card Slack keeps refusing, such as
 * after the bot leaves the channel, doesn't retry for the rest of the session.
 */
const WRITE_BACKOFF_MS = 5_000;
const MAX_FAILED_RENDERS = 4;
/** Agent sessions the lane reads in one render, as many as tasks can work at once, and events it reads from each. */
const MAX_AGENT_SESSIONS = MAX_WORKING_TASKS;
const MAX_AGENT_READ_EVENTS = 200;
/** A session read that stopped short of its tail continues this soon, refreshing or not. */
const CATCH_UP_MS = 1_000;
/** Pages of events a render reads from one agent session before it comes back for the rest. */
const MAX_AGENT_READ_PAGES = 5;
/** An agent's own turns kept per session, and its tool calls one `work()` returns. */
const MAX_AGENT_TURNS = 20;
const MAX_WORK_ACTIONS = 20;
const MIN_REFRESH_INTERVAL_MS = 1_000;

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
 * one line about how it ended. A stopped task shows as an error, never as a
 * success.
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
  const foldedFailure = tasks.some(
    (task) => folded.has(task.id) && (task.status === "failed" || task.status === "cancelled"),
  );
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

/** A turn's tracked calls. */
export interface SlackTaskCardState {
  readonly turn: TaskCardTurn;
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
 * Keeps each turn's calls in the channel's state from the session's own
 * events, around the renderer chain, so the card never depends on which
 * handlers a renderer keeps. Cards are written by {@link slackTaskCardLane},
 * outside the turn.
 */
export function withTaskCards(events: SlackChannelInternalEvents): SlackChannelInternalEvents {
  const wrapped: Partial<Record<TrackedEvent, TrackedHandler>> = {};
  for (const type of TRACKED_EVENTS) {
    const handler = events[type] as TrackedHandler | undefined;
    wrapped[type] = async (data, channel, ctx) => {
      trackEvent(channel.state, { data, type } as UnstampedMessageStreamEvent);
      await handler?.(data, channel, ctx);
    };
  }
  return { ...events, ...wrapped } as SlackChannelInternalEvents;
}

/** How eve keeps a Slack channel's task cards current. */
export interface SlackTaskCardOptions {
  /**
   * While an agent task whose events a card reads works, render the card again
   * this often, in milliseconds, at least 1,000, so it shows the agent's new
   * events. Without it, cards render only when the session's own events change
   * them.
   */
  readonly refreshIntervalMs?: number;
}

/**
 * Gives a Slack channel its task card lane, and records the session each agent
 * task opens so a card can read its events. `agent.started` is no public
 * channel event, so the channel observes it on its adapter directly.
 */
export function attachSlackTaskCards(
  channel: unknown,
  taskCard: TaskCardRenderer,
  options: SlackTaskCardOptions = {},
): void {
  const interval = options.refreshIntervalMs;
  if (
    interval !== undefined &&
    !(Number.isFinite(interval) && interval >= MIN_REFRESH_INTERVAL_MS)
  ) {
    throw new TypeError(
      `slackChannel({ taskCards: { refreshIntervalMs } }) must be at least ${String(MIN_REFRESH_INTERVAL_MS)} milliseconds; received ${String(interval)}.`,
    );
  }
  if (!isCompiledChannel(channel)) throw new TypeError("Expected a compiled Slack channel.");
  attachChannelRenderLane(channel, slackTaskCardLane(taskCard, interval));
  // An internal protocol event on the adapter the factory just built; no channel author sees it.
  const adapter = channel.adapter as {
    "agent.started"?: (
      data: AgentStartedStreamEvent["data"],
      ctx: { readonly state: SlackChannelState },
    ) => void;
  };
  adapter["agent.started"] = (data, ctx) => trackEvent(ctx.state, { data, type: "agent.started" });
}

function trackEvent(state: SlackChannelState, event: UnstampedMessageStreamEvent): void {
  const turns = Object.fromEntries(
    Object.entries(state.taskCards ?? {}).map(([turnId, card]) => [turnId, card.turn]),
  );
  const changed = trackTaskCardEvent(turns, event, new Date().toISOString());
  if (Object.keys(changed).length === 0) return;
  const cards = { ...state.taskCards };
  for (const [turnId, turn] of Object.entries(changed)) cards[turnId] = { turn };
  state.taskCards = forgetOldTurns(cards);
  state.taskCardRevision = (state.taskCardRevision ?? 0) + 1;
}

/** Keeps the newest turns, and only the few newest finished ones. */
function forgetOldTurns(
  cards: Record<string, SlackTaskCardState>,
): Record<string, SlackTaskCardState> {
  const turnIds = Object.keys(cards);
  const finished = turnIds.filter((turnId) => isFinished(cards[turnId]!.turn));
  const dropped = new Set([
    ...finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_TURNS)),
    ...turnIds.slice(0, Math.max(0, turnIds.length - MAX_TRACKED_TURNS)),
  ]);
  return Object.fromEntries(Object.entries(cards).filter(([turnId]) => !dropped.has(turnId)));
}

function isFinished(turn: TaskCardTurn): boolean {
  return taskCardView("", turn, { audience: "unknown" }).state === "finished";
}

/** What the lane remembers between renders: written cards and the agent sessions cards read. */
type TaskCardLaneState = {
  /** The `ts` and fingerprint eve last wrote for each tracked turn's card. */
  readonly cards: Readonly<Record<string, { readonly fingerprint: string; readonly ts: string }>>;
  /** Each agent session a card read: where its stream was read up to, and its folded turns. */
  readonly agents: Readonly<Record<string, AgentSessionFold>>;
  /** Each card whose latest version failed to land, and how many renders it failed. */
  readonly failures: Readonly<
    Record<string, { readonly fingerprint: string; readonly renders: number }>
  >;
};

/** An agent session's own turns, folded with the tracker the root's card uses. */
type AgentSessionFold = {
  readonly nextIndex: number;
  readonly turns: Readonly<Record<string, TaskCardTurn>>;
  /** When eve last read the session to its tail. */
  readonly readAt?: string;
};

type TaskCardRenderer = (
  view: TaskCardView,
) => SlackTaskCard | null | Promise<SlackTaskCard | null>;

/** The context `defineChannel` builds for Slack: eve's adapter context and the Slack surface. */
type SlackLaneContext = ChannelAdapterContext<SlackChannelState> & SlackEventContext;

/**
 * Writes each turn's task card from the channel's tracked turns, outside the
 * turn. It is the only writer of cards; see `ChannelRenderLane`.
 */
export function slackTaskCardLane(
  taskCard: TaskCardRenderer,
  refreshIntervalMs?: number,
): ChannelRenderLane<SlackLaneContext> {
  return {
    revision(state) {
      const { taskCardRevision, taskCards } = state as Partial<SlackChannelState>;
      return taskCards === undefined || taskCards === null || Object.keys(taskCards).length === 0
        ? undefined
        : String(taskCardRevision ?? 0);
    },
    async render(input) {
      return await renderTaskCards(
        input.channel,
        readLaneState(input.lane),
        taskCard,
        refreshIntervalMs,
      );
    },
  };
}

async function renderTaskCards(
  channel: SlackEventContext,
  lane: TaskCardLaneState,
  taskCard: TaskCardRenderer,
  refreshIntervalMs: number | undefined,
): Promise<ChannelRenderResult> {
  const { channelId, threadTs } = channel.state;
  const scheduled = contextStorage.getStore()?.get(ScheduleIdKey) !== undefined;
  // A schedule's session posts only its final reply, and a session without a thread has nowhere to post.
  if (!channelId || !threadTs || scheduled) {
    return { lane: { agents: {}, cards: lane.cards, failures: {} } };
  }
  const thread = { channelId, threadTs };
  const audience = normalizeChannelAudience(channel.state.audience);
  const turns = Object.entries(channel.state.taskCards ?? {});
  const agents = new AgentSessionReads(lane.agents);
  const agentWork = (call: TaskCardAgentCall) => agents.work(call);

  const cards: Record<string, { readonly fingerprint: string; readonly ts: string }> = {};
  const failures: Record<string, { readonly fingerprint: string; readonly renders: number }> = {};
  let retryInMs: number | undefined;
  for (const [turnId, tracked] of turns) {
    const written = lane.cards[turnId];
    if (written !== undefined) cards[turnId] = written;
    const view = taskCardView(turnId, tracked.turn, { agentWork, audience });
    const card = await renderCard(taskCard, view);
    if (card === null) continue;
    const fingerprint = createHash("sha256").update(JSON.stringify(card)).digest("base64url");
    if (fingerprint === written?.fingerprint) continue;
    const failed = lane.failures[turnId];
    const failedRenders = failed?.fingerprint === fingerprint ? failed.renders : 0;
    if (failedRenders >= MAX_FAILED_RENDERS) {
      failures[turnId] = { fingerprint, renders: failedRenders };
      continue;
    }
    try {
      cards[turnId] = {
        fingerprint,
        ts: await writeCardWithRetry(channel.slack, { ...thread, card, ts: written?.ts }),
      };
    } catch (error) {
      // The old fingerprint stays, so a later render writes the card again.
      logError(log, "task card write failed", error, { turnId });
      failures[turnId] = { fingerprint, renders: failedRenders + 1 };
      if (failedRenders + 1 < MAX_FAILED_RENDERS) {
        const backoff = WRITE_BACKOFF_MS * 2 ** failedRenders;
        retryInMs = Math.min(retryInMs ?? backoff, backoff);
      }
    }
  }

  const working = new Set(turns.flatMap(([, tracked]) => workingAgentSessions(tracked.turn)));
  const refreshing = agents.behind
    ? Math.min(CATCH_UP_MS, refreshIntervalMs ?? CATCH_UP_MS)
    : agents.read.some((sessionId) => working.has(sessionId))
      ? refreshIntervalMs
      : undefined;
  const wakeInMs =
    retryInMs === undefined || refreshing === undefined
      ? (retryInMs ?? refreshing)
      : Math.min(retryInMs, refreshing);
  // Folds last as long as a tracked turn still has the agent's task.
  const tracked = new Set(turns.flatMap(([, card]) => agentSessions(card.turn)));
  const next: TaskCardLaneState = { agents: agents.folds(tracked), cards, failures };
  return wakeInMs === undefined ? { lane: next } : { lane: next, wakeInMs };
}

/**
 * The agent sessions one render's cards read. Each session is read once per
 * render, from where the last read stopped, at most a few pages, and folded
 * with the tracker the root's card uses. A settled call whose session was read
 * to its tail after it settled is answered from its fold, so a render reads
 * only sessions still doing work for a call, at most as many as tasks can work
 * at once.
 */
class AgentSessionReads {
  readonly #folds: Record<string, AgentSessionFold>;
  readonly #reads = new Map<string, Promise<AgentSessionFold>>();
  behind = false;

  constructor(folds: TaskCardLaneState["agents"]) {
    this.#folds = { ...folds };
  }

  get read(): readonly string[] {
    return [...this.#reads.keys()];
  }

  async work(call: TaskCardAgentCall): Promise<TaskCardAgentWork> {
    const fold = await this.#fold(call);
    return taskCardAgentWork(fold.turns, call, MAX_WORK_ACTIONS);
  }

  /** Every fold whose session is still in `sessionIds`. */
  folds(sessionIds: ReadonlySet<string>): Record<string, AgentSessionFold> {
    return Object.fromEntries(
      Object.entries(this.#folds).filter(([sessionId]) => sessionIds.has(sessionId)),
    );
  }

  #fold(call: TaskCardAgentCall): Promise<AgentSessionFold> {
    const { remote, sessionId, settledAt } = call;
    const previous = this.#folds[sessionId] ?? { nextIndex: 0, turns: {} };
    let read = this.#reads.get(sessionId);
    if (read !== undefined) return read;
    const final =
      settledAt !== undefined && previous.readAt !== undefined && previous.readAt >= settledAt;
    if (final) return Promise.resolve(previous);
    if (this.#reads.size >= MAX_AGENT_SESSIONS) {
      this.behind = true;
      return Promise.resolve(previous);
    }
    read = this.#readFrom({ remote, sessionId }, previous);
    this.#reads.set(sessionId, read);
    return read;
  }

  async #readFrom(
    session: Pick<TaskCardAgentCall, "remote" | "sessionId">,
    previous: AgentSessionFold,
  ): Promise<AgentSessionFold> {
    const { remote, sessionId } = session;
    let fold = previous;
    for (let pages = 0; pages < MAX_AGENT_READ_PAGES; pages += 1) {
      const page = await readSessionEvents({
        limit: MAX_AGENT_READ_EVENTS,
        remote,
        sessionId,
        startIndex: fold.nextIndex,
      });
      fold = { nextIndex: page.nextIndex, turns: foldAgentEvents(fold.turns, page.events) };
      if (page.caughtUp) fold = { ...fold, readAt: new Date().toISOString() };
      this.#folds[sessionId] = fold;
      if (page.caughtUp) return fold;
    }
    this.behind = true;
    return fold;
  }
}

/** Folds an agent session's events into its turns, keeping the newest turns and no call input. */
function foldAgentEvents(
  turns: Readonly<Record<string, TaskCardTurn>>,
  events: readonly MessageStreamEvent[],
): Record<string, TaskCardTurn> {
  let folded: Record<string, TaskCardTurn> = { ...turns };
  for (const event of events) {
    const changed = trackTaskCardEvent(folded, event, event.meta.at);
    for (const [turnId, turn] of Object.entries(changed)) {
      folded[turnId] = {
        ...turn,
        calls: turn.calls.map(({ input: _input, ...call }) => call),
      };
    }
  }
  const turnIds = Object.keys(folded);
  if (turnIds.length > MAX_AGENT_TURNS) {
    folded = Object.fromEntries(Object.entries(folded).slice(-MAX_AGENT_TURNS));
  }
  return folded;
}

function readLaneState(lane: unknown): TaskCardLaneState {
  if (typeof lane !== "object" || lane === null) return { agents: {}, cards: {}, failures: {} };
  const { agents, cards, failures } = lane as Partial<TaskCardLaneState>;
  return { agents: agents ?? {}, cards: cards ?? {}, failures: failures ?? {} };
}

/** An authored card that throws leaves that turn's card as it was. */
async function renderCard(
  taskCard: TaskCardRenderer,
  view: TaskCardView,
): Promise<SlackTaskCard | null> {
  try {
    return await taskCard(view);
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

/** Writes a card, trying once more after a second. */
async function writeCardWithRetry(slack: SlackHandle, write: CardWrite): Promise<string> {
  try {
    return await writeCard(slack, write);
  } catch (error) {
    logError(log, "task card write failed; retrying", error);
    await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_MS));
    return await writeCard(slack, write);
  }
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
