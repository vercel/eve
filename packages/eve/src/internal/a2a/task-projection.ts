import { builtInHosts } from "#runtime/app.js";
import { renderTextInteraction } from "#channel/resolve-text.js";
import { signInChallengeText, signInOf } from "#channel/sign-in.js";
import { readSessionStreamTailIndex, streamSessionLines } from "#execution/session-event-stream.js";
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
  ResponseRow,
  SessionView,
  TurnRow,
} from "#protocol/session-projection/tables.js";
import { isV26Line } from "#protocol/v26-lines.js";

import { encodeTaskId, messageIdOfDelivery, type TaskRef } from "./ids.js";
import {
  A2A_JSON_RPC_ERRORS,
  isTerminalState,
  A2aError,
  a2aTimestamp,
  type Artifact,
  type Message,
  type Part,
  type Task,
  type TaskState,
  type TaskStatus,
} from "./protocol.js";

function legacySession(): A2aError {
  return new A2aError(
    A2A_JSON_RPC_ERRORS.unsupportedOperation,
    "This context was recorded by an earlier eve version and can't be read over A2A.",
  );
}

export async function readSessionView(sessionId: string): Promise<SessionView> {
  const view = emptySessionView();
  for await (const { line, position, record } of streamSessionLines(builtInHosts(), sessionId, {
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

export async function* followSessionView(
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<SessionView, void, undefined> {
  const tail = await readSessionStreamTailIndex(builtInHosts(), sessionId);
  const view = emptySessionView();
  if (tail < 0) yield view;
  for await (const { line, position, record } of streamSessionLines(builtInHosts(), sessionId, {
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
  readonly historyLength?: number;
  readonly includeArtifacts?: boolean;
  readonly toolActivity?: boolean;
  readonly failureText?: (failure: A2aFailure) => string;
}

/** A failure as a channel's `failureText` receives it. */
export interface A2aFailure {
  /** eve's error code, such as `MODEL_FAILED`, or `DELIVERY_FAILED` for a message that failed before its turn ran. */
  readonly code: string;
  /** The whole error message, which can carry internals such as an upstream page. */
  readonly message: string;
  /** The support id the server's logs carry the error under. */
  readonly id?: string;
}

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
    status: taskStatus(view, delivery, turn, { contextId, taskId: id }, options),
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

export function submittedTask(ref: TaskRef): Task {
  return {
    contextId: ref.sessionId,
    id: encodeTaskId(ref),
    status: { state: "TASK_STATE_SUBMITTED" },
  };
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
  options: ProjectTaskOptions,
): TaskStatus {
  if (delivery === undefined) return { state: "TASK_STATE_SUBMITTED" };
  if (turn === undefined) {
    if (delivery.status !== "settled") {
      return view.session.status === "ended"
        ? status("TASK_STATE_FAILED", address, view.session.endedAt, "The context ended.")
        : status("TASK_STATE_SUBMITTED", address, delivery.startedAt);
    }
    const state: TaskState =
      delivery.outcome === "refused" || delivery.outcome === "ignored"
        ? "TASK_STATE_REJECTED"
        : delivery.outcome === "failed"
          ? "TASK_STATE_FAILED"
          : "TASK_STATE_COMPLETED";
    const reason =
      state === "TASK_STATE_FAILED"
        ? describeFailure(options, {
            code: "DELIVERY_FAILED",
            message: delivery.reason ?? "The task failed.",
          })
        : delivery.reason;
    return status(state, address, delivery.endedAt, reason);
  }

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
      options.toolActivity === false ? undefined : workingLabel(view, turn.turnId),
    );
  }

  const error = failure(view, turn.turnId);
  if (error !== undefined || turn.outcome === "failed") {
    return status(
      "TASK_STATE_FAILED",
      address,
      turn.endedAt,
      describeFailure(
        options,
        error === undefined
          ? { code: "TURN_FAILED", message: "The task failed." }
          : {
              code: error.code,
              message: error.message,
              ...(error.id !== undefined && { id: error.id }),
            },
      ),
    );
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

function resumedAt(view: SessionView, turn: TurnRow): string {
  const answered = indexOf(view).endedPromptsByTurn.get(turn.turnId) ?? [];
  return latest([turn.startedAt, ...answered]) ?? turn.startedAt;
}

function latest(times: readonly string[]): string | undefined {
  return times.reduce<string | undefined>(
    (max, time) => (max === undefined || Date.parse(time) > Date.parse(max) ? time : max),
    undefined,
  );
}

export function openPromptsForTurn(view: SessionView, turnId: string): readonly InteractionRow[] {
  return indexOf(view).openPromptsByTurn.get(turnId) ?? [];
}

interface ViewIndex {
  readonly position: number;
  readonly deliveriesByTurn: ReadonlyMap<string, readonly DeliveryRow[]>;
  readonly responsesByTurn: ReadonlyMap<string, readonly ResponseRow[]>;
  readonly openPromptsByTurn: ReadonlyMap<string, readonly InteractionRow[]>;
  readonly endedPromptsByTurn: ReadonlyMap<string, readonly string[]>;
}

const viewIndexes = new WeakMap<SessionView, ViewIndex>();

function indexOf(view: SessionView): ViewIndex {
  const known = viewIndexes.get(view);
  if (known !== undefined && known.position === view.position) return known;
  const push = <T>(map: Map<string, T[]>, key: string | undefined, value: T) => {
    if (key === undefined) return;
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };
  const deliveriesByTurn = new Map<string, DeliveryRow[]>();
  for (const row of Object.values(view.deliveries)) push(deliveriesByTurn, row.turnId, row);
  const responsesByTurn = new Map<string, ResponseRow[]>();
  for (const row of Object.values(view.responses)) {
    push(responsesByTurn, interaction(view, row.interactionId)?.turnId, row);
  }
  const answered = answeredInteractionIds(view);
  const openPromptsByTurn = new Map<string, InteractionRow[]>();
  for (const row of [...openRequests(view), ...openSignIns(view)]) {
    if (answered.has(row.interactionId)) continue;
    push(openPromptsByTurn, interaction(view, row.interactionId)?.turnId, row);
  }
  for (const rows of openPromptsByTurn.values())
    rows.sort((a, b) => a.introducedAt - b.introducedAt);
  const endedPromptsByTurn = new Map<string, string[]>();
  for (const row of Object.values(view.interactions)) {
    if (row.endedAt === undefined) continue;
    push(endedPromptsByTurn, interaction(view, row.interactionId)?.turnId, row.endedAt);
  }
  const index = {
    deliveriesByTurn,
    endedPromptsByTurn,
    openPromptsByTurn,
    position: view.position,
    responsesByTurn,
  };
  viewIndexes.set(view, index);
  return index;
}

function promptMessage(
  view: SessionView,
  rows: readonly InteractionRow[],
  address: TaskAddress,
): Message {
  const text: string[] = [];
  for (const row of rows) {
    const asked = interaction(view, row.interactionId);
    if (asked === undefined) continue;
    const signIn = signInOf(view, row.interactionId);
    text.push(
      signIn === undefined ? renderTextInteraction(asked.request) : signInChallengeText(signIn),
    );
  }
  return agentMessage(
    address,
    `${address.taskId}:prompt:${rows.map((row) => row.interactionId).join(",")}`,
    [{ mediaType: "text/plain", text: text.join("\n\n") }],
  );
}

const MAX_FAILURE_TEXT_LENGTH = 300;

export function failureText(message: string | undefined, id?: string): string {
  const firstLine = (message ?? "")
    .split(/\r?\n/u)[0]!
    .replace(/<!doctype[\s\S]*$|<html[\s\S]*$/iu, "")
    .trim();
  const brief =
    firstLine.length === 0
      ? "The task failed."
      : firstLine.length > MAX_FAILURE_TEXT_LENGTH
        ? `${firstLine.slice(0, MAX_FAILURE_TEXT_LENGTH - 1)}…`
        : firstLine;
  return id === undefined ? brief : `${brief} (error id: ${id})`;
}

function describeFailure(options: ProjectTaskOptions, failure: A2aFailure): string {
  if (options.failureText !== undefined) {
    try {
      const text = options.failureText(failure);
      if (typeof text === "string" && text.length > 0) return text;
    } catch {}
  }
  return failureText(failure.message, failure.id);
}

function workingLabel(view: SessionView, turnId: string): string | undefined {
  const current = activity(view, { turnId });
  if (current.kind === "calling") return current.names.at(-1);
  if (current.kind === "waiting-on-tasks") return current.tasks.at(-1)?.name;
  return undefined;
}

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

function taskHistory(
  view: SessionView,
  ref: TaskRef,
  turnId: string | undefined,
  historyLength: number | undefined,
): readonly Message[] | undefined {
  if (historyLength === 0) return undefined;
  const taskId = encodeTaskId(ref);
  const userMessage = (deliveryId: string, parts: readonly Part[]): Message => ({
    contextId: ref.sessionId,
    messageId: messageIdOfDelivery(deliveryId) ?? deliveryId,
    parts,
    role: "ROLE_USER",
    taskId,
  });
  const entries: { readonly at: number; readonly message: Message }[] = [];
  const listed = new Set<string>();
  const index = indexOf(view);
  const rows =
    turnId === undefined
      ? [view.deliveries[ref.deliveryId]].filter((row) => row !== undefined)
      : (index.deliveriesByTurn.get(turnId) ?? []);
  for (const row of rows) {
    const parts = (row.parts ?? []).flatMap((part): Part[] =>
      part.kind === "text"
        ? [{ mediaType: "text/plain", text: part.text }]
        : part.url === undefined
          ? []
          : [{ filename: part.filename, mediaType: part.mediaType, url: part.url }],
    );
    if (parts.length === 0) continue;
    listed.add(row.deliveryId);
    entries.push({ at: row.introducedAt, message: userMessage(row.deliveryId, parts) });
  }
  if (turnId !== undefined) {
    for (const response of index.responsesByTurn.get(turnId) ?? []) {
      if (listed.has(response.deliveryId)) continue;
      const text = answerText(view, response.interactionId, response.value);
      if (text === undefined) continue;
      entries.push({
        at: response.introducedAt,
        message: userMessage(response.deliveryId, [{ mediaType: "text/plain", text }]),
      });
    }
  }
  const messages = entries.sort((a, b) => a.at - b.at).map((entry) => entry.message);
  return historyLength === undefined ? messages : messages.slice(-historyLength);
}

function answerText(
  view: SessionView,
  interactionId: string,
  value: { readonly optionId?: string; readonly text?: string } | undefined,
): string | undefined {
  if (value?.text !== undefined) return value.text;
  if (value?.optionId === undefined) return undefined;
  const option = view.interactions[interactionId]?.request.options?.find(
    (candidate) => candidate.id === value.optionId,
  );
  return option?.label ?? value.optionId;
}

export interface ContextTask {
  readonly ref: TaskRef;
  readonly task: Task;
  readonly at: number;
  readonly seq: number;
}

export function contextBusy(view: SessionView, sessionId: string): boolean {
  if (Object.values(view.turns).some((turn) => turn.status === "running")) return true;
  return contextTasks(view, sessionId, { historyLength: 0, includeArtifacts: false }).some(
    (entry) => !isTerminalState(entry.task.status.state),
  );
}

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
    const ref = { deliveryId: row.deliveryId, sessionId };
    const task = projectTask(view, ref, options);
    const at = task.status.timestamp === undefined ? 0 : Date.parse(task.status.timestamp);
    tasks.push({ at, ref, seq: row.introducedAt, task });
  }
  return tasks.sort(compareContextTasks);
}

export function compareContextTasks(
  a: Pick<ContextTask, "at" | "seq">,
  b: Pick<ContextTask, "at" | "seq">,
): number {
  return b.at - a.at || b.seq - a.seq;
}

export function hasRead(view: SessionView, deliveryId: string): boolean {
  const row = view.deliveries[deliveryId];
  if (row !== undefined) return row.status !== "admitted";
  return Object.values(view.responses).some((response) => response.deliveryId === deliveryId);
}

export function answerTurnedDown(view: SessionView, deliveryId: string): boolean {
  return Object.values(view.responses).some(
    (response) =>
      response.deliveryId === deliveryId &&
      response.status === "settled" &&
      response.outcome !== undefined &&
      response.outcome !== "applied",
  );
}

export function reachedTask(view: SessionView, task: TaskRef, deliveryId: string): TaskRef {
  if (deliveryId === task.deliveryId) return task;
  const reached = view.deliveries[deliveryId]?.turnId;
  const own = view.deliveries[task.deliveryId]?.turnId;
  return reached === undefined || reached === own
    ? task
    : { deliveryId, sessionId: task.sessionId };
}

export function hasDelivery(view: SessionView, deliveryId: string): boolean {
  return (
    view.deliveries[deliveryId] !== undefined ||
    Object.values(view.responses).some((response) => response.deliveryId === deliveryId)
  );
}
