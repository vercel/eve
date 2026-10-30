/**
 * Projects A2A tasks from an eve session's durable stream.
 *
 * One A2A task is the turn its starting delivery opened or joined. Follow-ups a client sends with
 * the task's `taskId` (refinements, typed answers) join that same turn, because an eve turn stays
 * running while it waits on interactions. Nothing here writes: every read folds the session's
 * lines, as the MCP channel's invocation reads do.
 */
import { renderTextInteraction } from "#channel/resolve-text.js";
import { signInChallengeText, signInOf } from "#channel/sign-in.js";
import { readSessionStreamTailIndex, streamSessionLines } from "#execution/session-event-stream.js";
import { interactionJson } from "#protocol/interaction-json.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { interaction, openRequests, openSignIns } from "#protocol/session-projection/reader.js";
import {
  activity,
  answeredInteractionIds,
  failure,
  reply,
  replyText,
} from "#protocol/session-projection/selectors.js";
import type {
  DeliveryRow,
  InteractionRow,
  SessionView,
  TurnRow,
} from "#protocol/session-projection/tables.js";
import { isV26Line } from "#protocol/v26-lines.js";
import type { JsonValue } from "#shared/json.js";

import { encodeTaskId, type TaskRef } from "./ids.js";
import {
  A2A_JSON_RPC_ERRORS,
  A2aError,
  a2aTimestamp,
  EVE_INTERACTIONS_EXTENSION,
  type Artifact,
  type Message,
  type Part,
  type Task,
  type TaskState,
  type TaskStatus,
} from "./protocol.js";

/** A session an eve before v27 recorded. A2A sessions never are, but a contextId can name one. */
function legacySession(): A2aError {
  return new A2aError(
    A2A_JSON_RPC_ERRORS.unsupportedOperation,
    "This context was recorded by an earlier eve version and can't be read over A2A.",
  );
}

/** The session folded to its current tail. */
export async function readSessionView(sessionId: string): Promise<SessionView> {
  const view = emptySessionView();
  for await (const { line, position, record } of streamSessionLines(sessionId, {
    follow: false,
  })) {
    if (line === undefined) {
      if (position === 0 && isV26Line(record)) throw legacySession();
      continue;
    }
    foldLine(view, line, position);
  }
  return view;
}

/**
 * The session folded to its tail, then again after every later line, until `signal` aborts or the
 * session's stream ends. Yields the same view object each time; read it before resuming.
 */
export async function* followSessionView(
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<SessionView, void, undefined> {
  const tail = await readSessionStreamTailIndex(sessionId);
  const view = emptySessionView();
  if (tail < 0) yield view;
  for await (const { line, position, record } of streamSessionLines(sessionId, {
    follow: true,
    signal,
  })) {
    if (line === undefined) {
      if (position === 0 && isV26Line(record)) throw legacySession();
      continue;
    }
    foldLine(view, line, position);
    if (position >= tail) yield view;
  }
}

export interface ProjectTaskOptions {
  /** `historyLength`: unset is unlimited, 0 omits history. */
  readonly historyLength?: number;
  /** Defaults to true; `ListTasks` omits artifacts unless asked. */
  readonly includeArtifacts?: boolean;
}

/** The A2A task a delivery started. */
export function projectTask(
  view: SessionView,
  ref: TaskRef,
  options: ProjectTaskOptions = {},
): Task {
  const id = encodeTaskId(ref);
  const contextId = ref.sessionId;
  const delivery = view.deliveries[ref.deliveryId];
  const turn = delivery?.turnId === undefined ? undefined : view.turns[delivery.turnId];
  const task: { -readonly [K in keyof Task]: Task[K] } = {
    contextId,
    id,
    status: taskStatus(view, delivery, turn, { contextId, taskId: id }),
  };
  if (
    task.status.state === "TASK_STATE_COMPLETED" &&
    turn !== undefined &&
    options.includeArtifacts !== false
  ) {
    const artifacts = replyArtifacts(view, turn.turnId);
    if (artifacts !== undefined) task.artifacts = artifacts;
  }
  const history = taskHistory(view, ref, turn?.turnId, options.historyLength);
  if (history !== undefined) task.history = history;
  return task;
}

interface TaskAddress {
  readonly contextId: string;
  readonly taskId: string;
}

function taskStatus(
  view: SessionView,
  delivery: DeliveryRow | undefined,
  turn: TurnRow | undefined,
  address: TaskAddress,
): TaskStatus {
  // Not yet visible on the stream: the session hasn't admitted the message.
  if (delivery === undefined) return { state: "TASK_STATE_SUBMITTED" };
  if (turn === undefined) {
    if (delivery.status !== "settled") {
      return view.session.status === "ended"
        ? status("TASK_STATE_FAILED", address, view.session.endedAt, "The context ended.")
        : status("TASK_STATE_SUBMITTED", address, delivery.startedAt);
    }
    // Settled without a turn: refused or ignored by the session, failed before it ran, or
    // applied as control.
    const state: TaskState =
      delivery.outcome === "refused" || delivery.outcome === "ignored"
        ? "TASK_STATE_REJECTED"
        : delivery.outcome === "failed"
          ? "TASK_STATE_FAILED"
          : "TASK_STATE_COMPLETED";
    return status(state, address, delivery.endedAt, delivery.reason);
  }

  // Open prompts outrank how the turn ended: a pending batch can outlive a settled turn.
  const prompts = openPromptsForTurn(view, turn.turnId);
  if (prompts.length > 0) {
    const asking = prompts.some((row) => row.request.kind !== "sign-in");
    return {
      message: promptMessage(view, prompts, address),
      state: asking ? "TASK_STATE_INPUT_REQUIRED" : "TASK_STATE_AUTH_REQUIRED",
      timestamp: a2aTimestamp(latest(prompts.map((row) => row.startedAt))),
    };
  }

  if (turn.status === "running") {
    if (view.session.status === "ended") {
      return status(
        "TASK_STATE_FAILED",
        address,
        view.session.endedAt,
        "The context ended before the task finished.",
      );
    }
    return status(
      "TASK_STATE_WORKING",
      address,
      resumedAt(view, turn),
      workingLabel(view, turn.turnId),
    );
  }

  const error = failure(view, turn.turnId);
  if (error !== undefined || turn.outcome === "failed") {
    return status("TASK_STATE_FAILED", address, turn.endedAt, error?.message ?? "The task failed.");
  }
  if (turn.outcome === "cancelled") return status("TASK_STATE_CANCELED", address, turn.endedAt);
  return status("TASK_STATE_COMPLETED", address, turn.endedAt);
}

function status(
  state: TaskState,
  address: TaskAddress,
  at: string | undefined,
  text?: string,
): TaskStatus {
  const result: { -readonly [K in keyof TaskStatus]: TaskStatus[K] } = { state };
  if (text !== undefined) {
    result.message = agentMessage(address, `${address.taskId}:status:${state}`, [
      { mediaType: "text/plain", text },
    ]);
  }
  const timestamp = a2aTimestamp(at);
  if (timestamp !== undefined) result.timestamp = timestamp;
  return result;
}

function agentMessage(address: TaskAddress, messageId: string, parts: readonly Part[]): Message {
  return {
    contextId: address.contextId,
    messageId,
    parts,
    role: "ROLE_AGENT",
    taskId: address.taskId,
  };
}

/** When the turn last went back to work: its start, or the latest prompt it was answered on. */
function resumedAt(view: SessionView, turn: TurnRow): string {
  const answered = Object.values(view.interactions).flatMap((row) =>
    row.endedAt !== undefined && interaction(view, row.interactionId)?.turnId === turn.turnId
      ? [row.endedAt]
      : [],
  );
  return latest([turn.startedAt, ...answered]) ?? turn.startedAt;
}

function latest(times: readonly string[]): string | undefined {
  return times.reduce<string | undefined>(
    (max, time) => (max === undefined || Date.parse(time) > Date.parse(max) ? time : max),
    undefined,
  );
}

/** The turn's open prompts no admitted answer covers yet, oldest first. */
function openPromptsForTurn(view: SessionView, turnId: string): readonly InteractionRow[] {
  const answered = answeredInteractionIds(view);
  return [...openRequests(view), ...openSignIns(view)]
    .filter(
      (row) =>
        !answered.has(row.interactionId) && interaction(view, row.interactionId)?.turnId === turnId,
    )
    .sort((a, b) => a.introducedAt - b.introducedAt);
}

/**
 * The status message for an interrupted task: the prompts as text any client can answer by typing
 * (eve's typed-answer intake resolves option IDs, labels, and numbers), plus the structured
 * interactions under eve's extension for clients that answer with a data part.
 *
 * A sign-in's link and code are credentials, but an A2A context has one principal, its owner, so
 * they go in the message as they would in a direct message.
 */
function promptMessage(
  view: SessionView,
  rows: readonly InteractionRow[],
  address: TaskAddress,
): Message {
  const interactions: JsonValue[] = [];
  const text: string[] = [];
  for (const row of rows) {
    const asked = interaction(view, row.interactionId);
    if (asked === undefined) continue;
    interactions.push(interactionJson(asked) as JsonValue);
    const signIn = signInOf(view, row.interactionId);
    text.push(
      signIn === undefined ? renderTextInteraction(asked.request) : signInChallengeText(signIn),
    );
  }
  return {
    ...agentMessage(
      address,
      `${address.taskId}:prompt:${rows.map((row) => row.interactionId).join(",")}`,
      [
        { mediaType: "text/plain", text: text.join("\n\n") },
        { data: { interactions }, mediaType: "application/json" },
      ],
    ),
    extensions: [EVE_INTERACTIONS_EXTENSION],
  };
}

function workingLabel(view: SessionView, turnId: string): string | undefined {
  const current = activity(view, { turnId });
  if (current.kind === "calling") return current.names.at(-1);
  if (current.kind === "waiting-on-tasks") return current.tasks.at(-1)?.name;
  return undefined;
}

/** The turn's reply as one artifact: its structured result when it has one, else its text. */
function replyArtifacts(view: SessionView, turnId: string): readonly Artifact[] | undefined {
  const structured = reply(view, turnId).find((part) => part.kind === "result");
  if (structured?.value !== undefined) {
    return [
      {
        artifactId: `${turnId}:result`,
        name: "result",
        parts: [{ data: structured.value, mediaType: "application/json" }],
      },
    ];
  }
  const text = replyText(view, turnId);
  if (text === undefined) return undefined;
  return [
    { artifactId: `${turnId}:reply`, name: "reply", parts: [{ mediaType: "text/markdown", text }] },
  ];
}

/** The task's user messages, the deliveries that joined its turn, newest last. */
function taskHistory(
  view: SessionView,
  ref: TaskRef,
  turnId: string | undefined,
  historyLength: number | undefined,
): readonly Message[] | undefined {
  if (historyLength === 0) return undefined;
  const taskId = encodeTaskId(ref);
  const rows = Object.values(view.deliveries)
    .filter((row) =>
      turnId === undefined ? row.deliveryId === ref.deliveryId : row.turnId === turnId,
    )
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const messages = rows.flatMap((row): Message[] => {
    const parts = (row.parts ?? []).flatMap((part): Part[] =>
      part.kind === "text"
        ? [{ mediaType: "text/plain", text: part.text }]
        : part.url === undefined
          ? []
          : [{ filename: part.filename, mediaType: part.mediaType, url: part.url }],
    );
    return parts.length === 0
      ? []
      : [{ contextId: ref.sessionId, messageId: row.deliveryId, parts, role: "ROLE_USER", taskId }];
  });
  return historyLength === undefined ? messages : messages.slice(-historyLength);
}

/** One task of a context with its `ListTasks` sort key. */
export interface ContextTask {
  readonly task: Task;
  /** Status time in epoch milliseconds; 0 when unknown. */
  readonly at: number;
  /** Stream position of the delivery that started it: the tie-breaker. */
  readonly seq: number;
}

/**
 * The tasks of one context: one per turn, named by the first delivery that reached it, plus each
 * message the session has yet to start or refused outright. Deliveries that settled without a turn
 * otherwise (answers, controls) belong to another task. Newest status first, as `ListTasks` sorts.
 */
export function contextTasks(
  view: SessionView,
  sessionId: string,
  options: ProjectTaskOptions = {},
): readonly ContextTask[] {
  const seenTurns = new Set<string>();
  const tasks: ContextTask[] = [];
  const rows = Object.values(view.deliveries).sort((a, b) => a.introducedAt - b.introducedAt);
  for (const row of rows) {
    if (row.turnId !== undefined) {
      if (seenTurns.has(row.turnId)) continue;
      seenTurns.add(row.turnId);
    } else if (
      row.status === "settled" &&
      row.outcome !== "refused" &&
      row.outcome !== "ignored" &&
      row.outcome !== "failed"
    ) {
      continue;
    }
    const task = projectTask(view, { deliveryId: row.deliveryId, sessionId }, options);
    const at = task.status.timestamp === undefined ? 0 : Date.parse(task.status.timestamp);
    tasks.push({ at, seq: row.introducedAt, task });
  }
  return tasks.sort(compareContextTasks);
}

/** Newest status first; among equal times, the later-started task first. */
export function compareContextTasks(
  a: Pick<ContextTask, "at" | "seq">,
  b: Pick<ContextTask, "at" | "seq">,
): number {
  return b.at - a.at || b.seq - a.seq;
}

/** Whether the session has read `deliveryId`: consumed or settled it, or admitted it as answers. */
export function hasRead(view: SessionView, deliveryId: string): boolean {
  const row = view.deliveries[deliveryId];
  if (row !== undefined) return row.status !== "admitted";
  return Object.values(view.responses).some((response) => response.deliveryId === deliveryId);
}

/** Whether `deliveryId` reached the session at all. */
export function hasDelivery(view: SessionView, deliveryId: string): boolean {
  return (
    view.deliveries[deliveryId] !== undefined ||
    Object.values(view.responses).some((response) => response.deliveryId === deliveryId)
  );
}
