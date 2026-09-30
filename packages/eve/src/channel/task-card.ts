import { isTaskControlTool } from "#protocol/task-tools.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { normalizePresentationText } from "#shared/presentation-text.js";

/** A call's input travels to renderers only up to this many characters of JSON. */
const MAX_ACTION_INPUT_LENGTH = 4_096;
/** Calls kept per turn; the oldest settled ones drop first. */
const MAX_CALLS_PER_TURN = 100;

/** How one of the turn's calls stands. */
export type TaskCardStatus = "working" | "completed" | "failed" | "cancelled";

/** One task call in a turn's task card. */
export interface TaskCardTask {
  /** The call's id; a resumable task called twice in a turn has two rows. */
  readonly id: string;
  readonly taskId: string;
  readonly kind: "agent" | "tool";
  /** The tool or agent name. */
  readonly name: string;
  /** The tool's start label, `agent: brief` for an agent, or the name. */
  readonly title: string;
  readonly status: TaskCardStatus;
  /**
   * One line describing the result once settled. A failure's line appears
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
 * each in call order. `working` while the turn or any of its tasks works,
 * then `finished`.
 */
export interface TaskCardView {
  readonly turnId: string;
  readonly state: "working" | "finished";
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
  };
}

/** One turn's calls as a channel tracks them from its session's own events. */
export interface TaskCardTurn {
  readonly calls: readonly TrackedCall[];
  readonly ended: boolean;
}

/**
 * Folds one of the session's own events into its turn's tracked calls.
 * Returns the turn it changed, or undefined when the event changes no card.
 */
export function trackTaskCardEvent(
  turns: Readonly<Record<string, TaskCardTurn>>,
  event: UnstampedMessageStreamEvent,
  at: string,
): { readonly turnId: string; readonly turn: TaskCardTurn } | undefined {
  switch (event.type) {
    case "actions.requested": {
      const { turnId } = event.data;
      const current = turns[turnId] ?? { calls: [], ended: false };
      const known = new Set(current.calls.map((call) => call.callId));
      const requested = event.data.actions.filter(
        (action) =>
          !known.has(action.callId) &&
          !(action.kind === "tool-call" && isTaskControlTool(action.toolName)),
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
  const working = !turn.ended || tasks.some((task) => task.status === "working");
  return { actions, state: working ? "working" : "finished", tasks, turnId };
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
  const name = actionName(action);
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
  const shown = call.status !== "failed" || audience === "private";
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

function actionName(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return "load_skill";
    case "subagent-call":
      return action.subagentName;
    case "remote-agent-call":
      return action.remoteAgentName;
    default:
      return action.toolName;
  }
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
      return firstLine(resultText(data.output));
    case "failed":
      return firstLine(data.error?.message);
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

function firstLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return presentationText(line);
}

function presentationText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizePresentationText(value);
  return normalized === "" ? undefined : normalized;
}
