// What a conversation reader shows, derived from the shared tables: turns, requests, sign-ins,
// tasks, and where each call stands. Clients, evals, adapters, and channels read these instead
// of folding a lifecycle of their own. Like the fold, this reads only the protocol, so clients
// and workflow bodies import it.

import type {
  InteractionOutcome,
  InteractionRequest,
} from "#protocol/session-events/families/interaction.js";
import type { Answer } from "#protocol/session-events/families/response.js";
import type { JsonValue } from "#shared/json.js";
import {
  callOutputSource,
  callRun,
  callTurn,
  interactionOwner,
  openInteractions,
  waiting,
} from "#protocol/session-projection/selectors.js";
import type { CallRow, InteractionRow, SessionView } from "#protocol/session-projection/tables.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// Turns and steps
// ---------------------------------------------------------------------------

export interface ReaderTurn {
  readonly turnId: string;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  /** The open turn is parked, holding on its tasks or on a person. */
  readonly waiting?: boolean;
}

/** Each turn as a reader shows it. */
export function readerTurns(view: SessionView): Readonly<Record<string, ReaderTurn>> {
  const turns: Record<string, ReaderTurn> = {};
  for (const [turnId, row] of Object.entries(view.turns)) {
    if (row.status === "running") {
      turns[turnId] =
        waiting(view, turnId) === undefined
          ? { status: "active", turnId }
          : { status: "active", turnId, waiting: true };
      continue;
    }
    const status =
      row.outcome === "completed" ? "completed" : row.outcome === "failed" ? "failed" : "cancelled";
    turns[turnId] = { status, turnId };
  }
  return turns;
}

/** Where a model run's output goes: its turn, and its step, the run's place among its turn's. */
export interface RunPlace {
  readonly turnId: string;
  readonly stepIndex: number;
}

export function runPlace(view: SessionView, runId: string | undefined): RunPlace | undefined {
  const row = runId === undefined ? undefined : view.runs[runId];
  if (row === undefined || row.step === undefined || !("turnId" in row.owner)) return undefined;
  return { stepIndex: row.step, turnId: row.owner.turnId };
}

/** A turn's latest step as of a position: the place of its last run introduced by then. */
export function turnStepAt(view: SessionView, turnId: string, position = Infinity): number {
  let step = 0;
  for (const row of Object.values(view.runs)) {
    if (row.step === undefined || row.introducedAt > position) continue;
    if ("turnId" in row.owner && row.owner.turnId === turnId) step = Math.max(step, row.step);
  }
  return step;
}

/** Where a call belongs: its run's place, or its turn's latest step when no run of a turn made it. */
export function callPlace(view: SessionView, callId: string): RunPlace | undefined {
  const row = view.calls[callId];
  if (row === undefined) return undefined;
  const place = runPlace(view, callRun(view, row));
  if (place !== undefined) return place;
  const turnId = callTurn(view, row) ?? view.session.latestTurnId;
  return turnId === undefined
    ? undefined
    : { stepIndex: turnStepAt(view, turnId, row.introducedAt), turnId };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** The approval this session asked about its own call, which the call waits on while open. */
function ownApproval(view: SessionView, callId: string): InteractionRow | undefined {
  let found: InteractionRow | undefined;
  for (const row of Object.values(view.interactions)) {
    if (
      row.request.kind === "approval" &&
      row.origin === undefined &&
      "callId" in row.subject &&
      row.subject.callId === callId
    )
      found = row;
  }
  return found;
}

/**
 * What an open call waits on: the approval this session asked about it, while that's open. Any
 * other open call is running, or waits on the runtime, as its row says.
 */
export function waitingOn(view: SessionView, callId: string): string | undefined {
  const row = view.calls[callId];
  if (row === undefined || row.status === "settled" || row.taskId !== undefined) return undefined;
  const approval = ownApproval(view, callId);
  return approval?.status === "open" ? approval.interactionId : undefined;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** One call that started or reached a task, settled by its `call.settled`. */
export interface ConversationTaskCall {
  readonly callId: string;
  readonly turnId: string;
  /** As the call's row stands: open while its task works on it, then settled. */
  readonly status: CallRow["status"];
  readonly outcome?: CallRow["outcome"];
  /** The call's result, once it completed. */
  readonly output?: JsonValue;
  /** Why the call failed. */
  readonly error?: { readonly message: string };
}

export interface ConversationTask {
  readonly taskId: string;
  /** The tool whose call started the task. */
  readonly name: string;
  /**
   * `"agent"` when a subagent's tool, local or remote, started the task; `"tool"` for an authored
   * tool, including one that opens sessions with `ctx.agent`.
   */
  readonly kind: "agent" | "tool";
  /** Calls in the order they reached the task. */
  readonly calls: Readonly<Record<string, ConversationTaskCall>>;
}

function taskCallOf(view: SessionView, row: CallRow): ConversationTaskCall {
  const call: Mutable<ConversationTaskCall> = {
    callId: row.callId,
    status: row.status,
    turnId: callTurn(view, row) ?? "",
  };
  if (row.outcome !== undefined) call.outcome = row.outcome;
  const output =
    row.outcome === "completed" ? callOutputSource(view, row.callId)?.output : undefined;
  if (output !== undefined) call.output = output;
  if (row.outcome !== "completed" && row.error !== undefined)
    call.error = { message: row.error.message };
  return call;
}

/** Each task with the calls that reached it. */
export function readerTasks(view: SessionView): Readonly<Record<string, ConversationTask>> {
  const calls = new Map<string, Record<string, ConversationTaskCall>>();
  for (const row of Object.values(view.calls)) {
    if (row.taskId === undefined) continue;
    const entries = calls.get(row.taskId) ?? {};
    entries[row.callId] = taskCallOf(view, row);
    calls.set(row.taskId, entries);
  }
  const tasks: Record<string, ConversationTask> = {};
  for (const row of Object.values(view.tasks)) {
    tasks[row.taskId] = {
      calls: calls.get(row.taskId) ?? {},
      kind: row.kind === "agent" ? "agent" : "tool",
      name: row.name,
      taskId: row.taskId,
    };
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Why a request nobody answered closed when a message steered its turn instead. */
export const SUPERSEDED_BY_MESSAGE = "superseded-by-message";

/** The call an interaction asks about. */
export interface AskedCall {
  readonly callId: string;
  readonly name: string;
  readonly input?: JsonValue;
}

/**
 * The call an interaction asks about, such as the tool an approval would run: a relayed
 * request's asker's call, which lives in the child's session, or else the subject's call here.
 */
export function askedCall(view: SessionView, row: InteractionRow): AskedCall | undefined {
  // A relayed request's subject is the call that serves its asker here; what it asks about is
  // only what its origin names, which is nothing for a budget prompt.
  if (row.origin !== undefined) return row.origin.call;
  if (!("callId" in row.subject)) return undefined;
  const call = view.calls[row.subject.callId];
  if (call === undefined) return undefined;
  return call.input === undefined
    ? { callId: call.callId, name: call.capability.name }
    : { callId: call.callId, input: call.input, name: call.capability.name };
}

/** Where an interaction opened: the turn it holds, its step then, and the task whose run asks. */
export interface InteractionPlace {
  readonly turnId: string;
  readonly stepIndex: number;
  readonly taskId?: string;
}

export function interactionPlace(view: SessionView, row: InteractionRow): InteractionPlace {
  const owner = interactionOwner(view, row);
  const turnId = owner.turnId ?? view.session.latestTurnId ?? "turn_0";
  const place: Mutable<InteractionPlace> = {
    stepIndex: turnStepAt(view, turnId, row.introducedAt),
    turnId,
  };
  const taskId = owner.taskId ?? ("taskId" in row.subject ? row.subject.taskId : undefined);
  if (taskId !== undefined) place.taskId = taskId;
  return place;
}

/** An interaction as a conversation reader shows it: what it asks, where, and how it stands. */
export interface Interaction extends InteractionPlace {
  readonly interactionId: string;
  readonly request: InteractionRequest;
  readonly call?: AskedCall;
  readonly status: "open" | "settled";
  readonly outcome?: InteractionOutcome;
  readonly reason?: string;
  /** The deciding answer once settled; while open, the latest unsettled submitted answer. */
  readonly answer?: Answer;
}

export function interaction(view: SessionView, interactionId: string): Interaction | undefined {
  const row = view.interactions[interactionId];
  if (row === undefined) return undefined;
  const shown: Mutable<Interaction> = {
    ...interactionPlace(view, row),
    interactionId,
    request: row.request,
    status: row.status,
  };
  const call = askedCall(view, row);
  if (call !== undefined) shown.call = call;
  if (row.outcome !== undefined) shown.outcome = row.outcome;
  if (row.reason !== undefined) shown.reason = row.reason;
  let answer = decidingAnswer(row);
  if (row.status === "open") {
    for (const response of Object.values(view.responses)) {
      if (response.interactionId !== interactionId || response.status === "settled") continue;
      if (response.value !== undefined) answer = { ...response.value, interactionId };
    }
  }
  if (answer !== undefined) shown.answer = answer;
  return shown;
}

/** The answer that decided a settled interaction, as it was given. */
export function decidingAnswer(row: InteractionRow): Answer | undefined {
  const value = row.response;
  if (value === undefined) return undefined;
  const answer: { interactionId: string; optionId?: string; text?: string } = {
    interactionId: row.interactionId,
  };
  if (typeof value.optionId === "string") answer.optionId = value.optionId;
  if (typeof value.text === "string") answer.text = value.text;
  return answer.optionId === undefined && answer.text === undefined ? undefined : answer;
}

/**
 * The approvals, questions, and budget prompts the session still waits on an answer to, oldest
 * first: the server's one source for whether a request is open. A sign-in completes by its
 * callback, not an answer (`openSignIns`).
 */
export function openRequests(view: SessionView | undefined): readonly InteractionRow[] {
  if (view === undefined) return [];
  return openInteractions(view).filter((row) => row.request.kind !== "sign-in");
}

/** Sign-ins the session still waits on, in the order they opened. */
export function openSignIns(view: SessionView | undefined): readonly InteractionRow[] {
  return view === undefined ? [] : openInteractions(view, { kind: "sign-in" });
}

/** How a sign-in's end reads to a person: connected, or why it didn't. */
export function signInEnding(
  outcome: InteractionOutcome,
): "connected" | "declined" | "failed" | "timed out" | "cancelled" {
  switch (outcome) {
    case "accepted":
      return "connected";
    case "declined":
    case "invalid":
      return "declined";
    case "failed":
      return "failed";
    case "expired":
      return "timed out";
    default:
      return "cancelled";
  }
}
