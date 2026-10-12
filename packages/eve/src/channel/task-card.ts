import {
  callOutputSource,
  callTurn,
  interactionOwner,
  openInteractions,
} from "#protocol/session-projection/selectors.js";
import type { CallRow, SessionView } from "#protocol/session-projection/tables.js";
import type { InteractionRequest } from "#protocol/session-events/families/interaction.js";
import type { TaskCancelReason } from "#protocol/message.js";
import type { CallOutcome } from "#protocol/session-events/families/call.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import { displayTitle } from "#shared/display-name.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { firstSentence, normalizePresentationText } from "#shared/presentation-text.js";

/** A call's input travels to renderers only up to this many characters of JSON. */
const MAX_ACTION_INPUT_LENGTH = 4_096;
/** Calls kept per turn; the oldest settled ones drop first. */
const MAX_CALLS_PER_TURN = 100;
const MAX_BLOCKER_LABEL_LENGTH = 200;

/** How one of the turn's calls stands. */
export type TaskCardStatus = "working" | "completed" | "failed" | "cancelled";

/** What a blocked task waits on: a person's approval, answer, or sign-in. */
export interface TaskCardBlocker {
  readonly kind: "approval" | "authorization" | "input";
  /**
   * The request's prompt or the connection's name. Only in a private
   * conversation, since a request can be sent to one person alone.
   */
  readonly label?: string;
}

/** One task call in a turn's task card. */
export interface TaskCardTask {
  /** The call's id; a resumable task called twice in a turn has two rows. */
  readonly id: string;
  readonly taskId: string;
  readonly kind: "agent" | "tool";
  /** The tool or agent name. */
  readonly name: string;
  /**
   * The tool's start label, or the name's display title. An agent's is
   * `Researcher: brief`, or the brief alone for a call to the agent's own copy.
   */
  readonly title: string;
  /** `blocked` while the task waits on a person; see {@link TaskCardTask.blockedOn}. */
  readonly status: TaskCardStatus | "blocked";
  readonly blockedOn?: TaskCardBlocker;
  /**
   * The first sentence of the result once settled. A failure's line appears
   * only in a private conversation, since error text can carry internals.
   */
  readonly summary?: string;
  /**
   * Why a cancelled task stopped: `task_cancel` when the model no longer
   * needed it. Absent when the task's run stopped on its own.
   */
  readonly cancelReason?: TaskCancelReason;
  readonly startedAt: string;
  readonly settledAt?: string;
}

/**
 * One of the turn's own tool calls that doesn't run as a task, such as a call
 * to an app's `plan` tool whose input a renderer shows as rows.
 */
export interface TaskCardAction {
  /** The call's id. */
  readonly id: string;
  /** The tool name. */
  readonly name: string;
  /** The tool's start label, or the name's display title. */
  readonly title: string;
  readonly status: TaskCardStatus;
  /** The call's input, when its JSON is at most 4,096 characters. */
  readonly input?: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly settledAt?: string;
}

/**
 * One turn's own tool calls: the tasks it started, and its other actions,
 * each in call order. `blocked` while any task waits on a person, `working`
 * while the turn or any other task works, then `finished`.
 */
export interface TaskCardView {
  readonly turnId: string;
  readonly state: "working" | "blocked" | "finished";
  readonly tasks: readonly TaskCardTask[];
  readonly actions: readonly TaskCardAction[];
}

/**
 * Where one card of a turn begins. A turn keeps one card unless it starts a task after every task
 * on its card settled, as a turn its caller keeps talking to does: the settled card ends there,
 * and a new one begins with the calls from that line on and the ones still working.
 */
export interface TaskCardSegment {
  /** The line the card begins at. */
  readonly since: number;
  /** Calls from before `since` still working when the card began. */
  readonly carried?: readonly string[];
}

/** The view a renderer draws one card of a turn from, read from the session's tables. */
export function taskCardView(
  view: SessionView,
  turnId: string,
  options: { readonly audience: ChannelAudience; readonly segment?: TaskCardSegment },
): TaskCardView {
  const tasks: TaskCardTask[] = [];
  const actions: TaskCardAction[] = [];
  for (const row of cardCalls(view, turnId, options.segment)) {
    if (row.taskId === undefined) actions.push(toAction(row));
    else tasks.push(toTask(view, row, row.taskId, options.audience));
  }
  const state = tasks.some((task) => task.status === "blocked")
    ? "blocked"
    : view.turns[turnId]?.status === "running" || tasks.some((task) => task.status === "working")
      ? "working"
      : "finished";
  return { actions, state, tasks, turnId };
}

/**
 * The card a split ends: its settled calls, finished. Returns nothing while any of its tasks
 * works, or when it has none, since then the turn keeps its card.
 */
export function closedTaskCard(card: TaskCardView): TaskCardView | undefined {
  const settled = (status: TaskCardTask["status"]) => status !== "working" && status !== "blocked";
  if (card.tasks.length === 0 || !card.tasks.every((task) => settled(task.status)))
    return undefined;
  return {
    ...card,
    actions: card.actions.filter((action) => settled(action.status)),
    state: "finished",
  };
}

/** The card that begins at a call starting a task, carrying the turn's calls still working. */
export function nextSegment(view: SessionView, turnId: string, callId: string): TaskCardSegment {
  const since = view.calls[callId]?.introducedAt ?? view.position;
  const carried = cardCalls(view, turnId, undefined)
    .filter((row) => row.status !== "settled" && row.introducedAt < since)
    .map((row) => row.callId);
  return carried.length === 0 ? { since } : { carried, since };
}

/** The names of a turn's working tasks, for a status such as `Waiting on researcher...`. */
export function workingTaskNames(view: SessionView, turnId: string): readonly string[] {
  return cardCalls(view, turnId, undefined)
    .filter((row) => row.taskId !== undefined && row.status !== "settled")
    .map((row) => row.capability.name);
}

/**
 * The turn's own calls a card shows, in call order: eve's task controls, and calls a tool makes
 * on the model's behalf, stay out of view. The oldest settled ones drop past the card's bound.
 */
function cardCalls(
  view: SessionView,
  turnId: string,
  segment: TaskCardSegment | undefined,
): readonly CallRow[] {
  const carried = new Set(segment?.carried);
  const calls = Object.values(view.calls)
    .filter(
      (row) =>
        row.capability.kind !== "control" &&
        !("callId" in row.owner) &&
        callTurn(view, row) === turnId &&
        (segment === undefined || row.introducedAt >= segment.since || carried.has(row.callId)),
    )
    .sort((a, b) => a.introducedAt - b.introducedAt);
  let overflow = calls.length - MAX_CALLS_PER_TURN;
  return overflow <= 0
    ? calls
    : calls.filter((row) => {
        if (overflow > 0 && row.status === "settled") {
          overflow -= 1;
          return false;
        }
        return true;
      });
}

function titleOf(row: CallRow): string {
  return row.title ?? row.capability.title ?? displayTitle(row.capability.name);
}

function statusOf(row: CallRow): TaskCardStatus {
  return row.status === "settled" && row.outcome !== undefined
    ? callStatus(row.outcome)
    : "working";
}

function toAction(row: CallRow): TaskCardAction {
  const action: { -readonly [K in keyof TaskCardAction]: TaskCardAction[K] } = {
    id: row.callId,
    name: row.capability.name,
    startedAt: row.startedAt,
    status: statusOf(row),
    title: titleOf(row),
  };
  const input = boundedInput(row.input);
  if (input !== undefined) action.input = input;
  if (row.endedAt !== undefined) action.settledAt = row.endedAt;
  return action;
}

function toTask(
  view: SessionView,
  row: CallRow,
  taskId: string,
  audience: ChannelAudience,
): TaskCardTask {
  const status = statusOf(row);
  const kind = view.tasks[taskId]?.kind ?? (row.capability.kind === "agent" ? "agent" : "tool");
  const task: { -readonly [K in keyof TaskCardTask]: TaskCardTask[K] } = {
    id: row.callId,
    kind: kind === "agent" ? "agent" : "tool",
    name: row.capability.name,
    startedAt: row.startedAt,
    status,
    taskId,
    title: titleOf(row),
  };
  const shareable = audience === "private";
  // Only a task's requests block its card; the turn's own block the turn.
  const waitingOn =
    status === "working"
      ? openInteractions(view)
          .filter((entry) => interactionOwner(view, entry).taskId === taskId)
          .at(-1)
      : undefined;
  if (waitingOn !== undefined) {
    const blocker = blockerOf(waitingOn.request);
    task.status = "blocked";
    task.blockedOn = shareable && blocker.label !== undefined ? blocker : { kind: blocker.kind };
  }
  const summary = taskSummary({
    error: row.error,
    output: callOutputSource(view, row.callId)?.output ?? row.output,
    status,
  });
  if (summary !== undefined && (status !== "failed" || shareable)) task.summary = summary;
  const { reason } = row;
  if (reason === "task_cancel" || reason === "turn_cancelled" || reason === "turn_ended")
    task.cancelReason = reason;
  if (row.endedAt !== undefined) task.settledAt = row.endedAt;
  return task;
}

/** What a request asks of a person, and its prompt or the connection's name. */
function blockerOf(request: InteractionRequest): TaskCardBlocker {
  const signIn = request.kind === "sign-in";
  const kind = signIn ? "authorization" : request.kind === "question" ? "input" : "approval";
  const text = signIn
    ? (request.signIn?.displayName ?? request.signIn?.name ?? request.prompt)
    : request.prompt;
  const label = presentationText(text)?.slice(0, MAX_BLOCKER_LABEL_LENGTH);
  return label === undefined ? { kind } : { kind, label };
}

function callStatus(outcome: CallOutcome): TaskCardStatus {
  switch (outcome) {
    case "completed":
      return "completed";
    case "interrupted":
    case "abandoned":
      return "cancelled";
    default:
      return "failed";
  }
}

function boundedInput(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return JSON.stringify(value).length <= MAX_ACTION_INPUT_LENGTH
    ? (value as JsonObject)
    : undefined;
}

function taskSummary(data: {
  readonly error?: { readonly message: string };
  readonly output?: JsonValue;
  readonly status: TaskCardStatus;
}): string | undefined {
  switch (data.status) {
    case "completed":
      return brief(resultText(data.output));
    case "failed":
      return brief(data.error?.message);
    default:
      return undefined;
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

function presentationText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizePresentationText(value);
  return normalized === "" ? undefined : normalized;
}
