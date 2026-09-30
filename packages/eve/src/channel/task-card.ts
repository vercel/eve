import { isTaskControlTool } from "#protocol/task-tools.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { actionRequestName } from "#shared/action-request-name.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
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
   * The tool's start label, or the name. An agent's is `researcher: brief`,
   * or the brief alone for a call to the agent's own copy.
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
  /** The tool's start label, or the name. */
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

/** One call as a channel tracks it: plain JSON, kept in the channel's state. */
interface TrackedCall {
  readonly callId: string;
  readonly name: string;
  readonly title: string;
  readonly status: TaskCardStatus;
  readonly startedAt: string;
  readonly input?: JsonObject;
  readonly settledAt?: string;
  readonly task?: {
    readonly id: string;
    readonly kind: "agent" | "tool";
    readonly summary?: string;
    /** Open requests and sign-ins the task waits on, oldest first. */
    readonly blockers?: readonly (TaskCardBlocker & { readonly id: string })[];
  };
}

/** One turn's calls as a channel tracks them from its session's own events. */
export interface TaskCardTurn {
  readonly calls: readonly TrackedCall[];
  readonly ended: boolean;
}

type TurnChanges = Readonly<Record<string, TaskCardTurn>>;

/**
 * Folds one of the session's events into the turns' tracked calls, including
 * the requests a task's run relays through the session. Returns each turn it
 * changed, by turn id; none when the event changes no card.
 */
export function trackTaskCardEvent(
  turns: Readonly<Record<string, TaskCardTurn>>,
  event: UnstampedMessageStreamEvent,
  at: string,
): TurnChanges {
  switch (event.type) {
    case "input.requested": {
      const { requests, taskId } = event.data;
      if (taskId === undefined) return {};
      const requested = requests.map((request) =>
        blocker(
          request.requestId,
          request.kind === "question" ? "input" : "approval",
          request.prompt,
        ),
      );
      return updateBlockers(turns, taskId, (open) => [...open, ...requested]);
    }
    case "input.resolved": {
      const resolved = new Set(event.data.resolutions.map((resolution) => resolution.requestId));
      return updateBlockers(turns, undefined, (open) =>
        open.filter((item) => !resolved.has(item.id)),
      );
    }
    case "authorization.required": {
      const { taskId } = event.data;
      if (taskId === undefined) return {};
      const id = authorizationId(event.data);
      const label = event.data.authorization?.displayName ?? event.data.name;
      return updateBlockers(turns, taskId, (open) => [
        ...open.filter((item) => item.id !== id),
        blocker(id, "authorization", label),
      ]);
    }
    case "authorization.completed": {
      const id = authorizationId(event.data);
      return updateBlockers(turns, event.data.taskId, (open) =>
        open.filter((item) => item.id !== id),
      );
    }
    default: {
      const changed = trackTurnEvent(turns, event, at);
      return changed === undefined ? {} : { [changed.turnId]: changed.turn };
    }
  }
}

type TrackedBlocker = NonNullable<NonNullable<TrackedCall["task"]>["blockers"]>[number];

function blocker(id: string, kind: TaskCardBlocker["kind"], text: string): TrackedBlocker {
  const label = presentationText(text)?.slice(0, MAX_BLOCKER_LABEL_LENGTH);
  return label === undefined ? { id, kind } : { id, kind, label };
}

function authorizationId(data: {
  readonly attemptId?: string;
  readonly candidateId?: string;
  readonly name: string;
}): string {
  return data.attemptId ?? data.candidateId ?? data.name;
}

/** Applies `update` to the open blockers of each working task call, or only `taskId`'s. */
function updateBlockers(
  turns: Readonly<Record<string, TaskCardTurn>>,
  taskId: string | undefined,
  update: (open: readonly TrackedBlocker[]) => readonly TrackedBlocker[],
): TurnChanges {
  const changes: Record<string, TaskCardTurn> = {};
  for (const [turnId, turn] of Object.entries(turns)) {
    for (const call of turn.calls) {
      if (call.task === undefined || call.status !== "working") continue;
      if (taskId !== undefined && call.task.id !== taskId) continue;
      const open = call.task.blockers ?? [];
      const next = update(open);
      if (next.length === open.length && next.every((item, index) => item.id === open[index]!.id)) {
        continue;
      }
      const task = { ...call.task, blockers: next };
      changes[turnId] = replaceCall(changes[turnId] ?? turn, { ...call, task });
    }
  }
  return changes;
}

function trackTurnEvent(
  turns: Readonly<Record<string, TaskCardTurn>>,
  event: UnstampedMessageStreamEvent,
  at: string,
): { readonly turnId: string; readonly turn: TaskCardTurn } | undefined {
  switch (event.type) {
    case "actions.requested": {
      const { turnId } = event.data;
      const current = turns[turnId] ?? { calls: [], ended: false };
      const known = new Set(current.calls.map((call) => call.callId));
      // Nested actions (such as a connection tool run by connection_execute)
      // already appear as their parent call's row.
      const requested = event.data.actions.filter(
        (action) =>
          !known.has(action.callId) &&
          !(
            action.kind === "tool-call" &&
            (isTaskControlTool(action.toolName) || action.parentCallId !== undefined)
          ),
      );
      if (requested.length === 0) return undefined;
      const calls = requested.map((action) =>
        requestedCall(action, event.data.presentation?.[action.callId]?.label, at),
      );
      return { turn: { ...current, calls: bounded([...current.calls, ...calls]) }, turnId };
    }
    case "action.result": {
      const { turnId } = event.data;
      const current = turns[turnId];
      const call = current?.calls.find(
        (candidate) => candidate.callId === event.data.result.callId,
      );
      // A task call's result is its receipt; the task settles with `task.settled`.
      if (current === undefined || call === undefined || call.task !== undefined) return undefined;
      const status = actionStatus(event.data.status);
      return { turn: replaceCall(current, { ...call, settledAt: at, status }), turnId };
    }
    case "task.started": {
      const { callId, kind, name, taskId, turnId } = event.data;
      const current = turns[turnId] ?? { calls: [], ended: false };
      const call = current.calls.find((candidate) => candidate.callId === callId) ?? {
        callId,
        name,
        startedAt: at,
        status: "working",
        title: name,
      };
      const started: TrackedCall = {
        callId: call.callId,
        name: call.name,
        startedAt: call.startedAt,
        status: "working",
        task: { id: taskId, kind },
        title: call.title,
      };
      return { turn: replaceCall(current, started), turnId };
    }
    case "task.settled": {
      const { callId, status, turnId } = event.data;
      const current = turns[turnId];
      const call = current?.calls.find((candidate) => candidate.callId === callId);
      if (current === undefined || call?.task === undefined) return undefined;
      const task: {
        -readonly [K in keyof NonNullable<TrackedCall["task"]>]: NonNullable<
          TrackedCall["task"]
        >[K];
      } = {
        id: call.task.id,
        kind: call.task.kind,
      };
      const summary = taskSummary(event.data);
      if (summary !== undefined) task.summary = summary;
      return { turn: replaceCall(current, { ...call, settledAt: at, status, task }), turnId };
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      const current = turns[event.data.turnId];
      if (current === undefined || current.ended) return undefined;
      return { turn: { ...current, ended: true }, turnId: event.data.turnId };
    }
    default:
      return undefined;
  }
}

/** The view a renderer draws one turn's card from. */
export function taskCardView(
  turnId: string,
  turn: TaskCardTurn,
  options: { readonly audience: ChannelAudience },
): TaskCardView {
  const tasks: TaskCardTask[] = [];
  const actions: TaskCardAction[] = [];
  for (const call of turn.calls) {
    if (call.task === undefined) actions.push(toAction(call));
    else tasks.push(toTask(call, call.task, options.audience));
  }
  const state = tasks.some((task) => task.status === "blocked")
    ? "blocked"
    : !turn.ended || tasks.some((task) => task.status === "working")
      ? "working"
      : "finished";
  return { actions, state, tasks, turnId };
}

/** The names of a turn's working tasks, for a status such as `Waiting on researcher...`. */
export function workingTaskNames(turn: TaskCardTurn | undefined): readonly string[] {
  return (turn?.calls ?? [])
    .filter((call) => call.task !== undefined && call.status === "working")
    .map((call) => call.name);
}

function requestedCall(
  action: RuntimeActionRequest,
  label: string | undefined,
  at: string,
): TrackedCall {
  const name = actionRequestName(action);
  const call: { -readonly [K in keyof TrackedCall]: TrackedCall[K] } = {
    callId: action.callId,
    name,
    startedAt: at,
    status: "working",
    title: presentationText(label) ?? name,
  };
  const input = boundedInput(action.input);
  if (input !== undefined) call.input = input;
  return call;
}

function toAction(call: TrackedCall): TaskCardAction {
  const action: { -readonly [K in keyof TaskCardAction]: TaskCardAction[K] } = {
    id: call.callId,
    name: call.name,
    startedAt: call.startedAt,
    status: call.status,
    title: call.title,
  };
  if (call.input !== undefined) action.input = call.input;
  if (call.settledAt !== undefined) action.settledAt = call.settledAt;
  return action;
}

function toTask(
  call: TrackedCall,
  task: NonNullable<TrackedCall["task"]>,
  audience: ChannelAudience,
): TaskCardTask {
  const row: { -readonly [K in keyof TaskCardTask]: TaskCardTask[K] } = {
    id: call.callId,
    kind: task.kind,
    name: call.name,
    startedAt: call.startedAt,
    status: call.status,
    taskId: task.id,
    title: call.title,
  };
  const shareable = audience === "private";
  const waitingOn = call.status === "working" ? task.blockers?.at(-1) : undefined;
  if (waitingOn !== undefined) {
    row.status = "blocked";
    row.blockedOn =
      shareable && waitingOn.label !== undefined
        ? { kind: waitingOn.kind, label: waitingOn.label }
        : { kind: waitingOn.kind };
  }
  const shown = call.status !== "failed" || shareable;
  if (task.summary !== undefined && shown) row.summary = task.summary;
  if (call.settledAt !== undefined) row.settledAt = call.settledAt;
  return row;
}

function replaceCall(turn: TaskCardTurn, call: TrackedCall): TaskCardTurn {
  const known = turn.calls.some((candidate) => candidate.callId === call.callId);
  const calls = known
    ? turn.calls.map((candidate) => (candidate.callId === call.callId ? call : candidate))
    : [...turn.calls, call];
  return { ...turn, calls: bounded(calls) };
}

/** Keeps a turn within {@link MAX_CALLS_PER_TURN} by dropping its oldest settled calls. */
function bounded(calls: readonly TrackedCall[]): readonly TrackedCall[] {
  let overflow = calls.length - MAX_CALLS_PER_TURN;
  if (overflow <= 0) return calls;
  return calls.filter((call) => {
    if (overflow > 0 && call.status !== "working") {
      overflow -= 1;
      return false;
    }
    return true;
  });
}

function actionStatus(status: string): TaskCardStatus {
  switch (status) {
    case "completed":
    case "cancelled":
      return status;
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
