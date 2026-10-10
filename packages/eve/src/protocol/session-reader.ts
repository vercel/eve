// What a conversation reader shows, derived from the shared tables: turns, requests, sign-ins,
// tasks, and where each call stands. Clients, evals, adapters, and channels read these instead
// of folding a lifecycle of their own. Like the fold, this reads only the protocol, so clients
// and workflow bodies import it.

import { SESSION_LIMIT_CONTINUATION_TOOL_NAME } from "#protocol/budget-request.js";
import type {
  ActionResultError,
  AuthorizationOutcome,
  InputResolutionOutcome,
} from "#protocol/message.js";
import type {
  InteractionOutcome,
  InteractionRequest,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import type { InputOption, InputRequest, InputResponse } from "#shared/input.js";
import { isJsonObjectValue, type JsonValue } from "#shared/json.js";
import {
  activeTurn,
  callOutputSource,
  callRun,
  callTurn,
  interactionOwner,
  openInteractions,
  runTurn,
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
  for (const row of Object.values(view.turns)) {
    if (row.status !== "settled") {
      turns[row.turnId] =
        row.status === "paused"
          ? { status: "active", turnId: row.turnId, waiting: true }
          : { status: "active", turnId: row.turnId };
      continue;
    }
    const status =
      row.outcome === "completed" ? "completed" : row.outcome === "failed" ? "failed" : "cancelled";
    turns[row.turnId] = { status, turnId: row.turnId };
  }
  return turns;
}

/** The open turn, running or paused. */
export function activeTurnId(view: SessionView): string | undefined {
  return activeTurn(view)?.turnId;
}

/** Where a model run's output goes: its turn, and its step, the run's place among its turn's. */
export interface RunPlace {
  readonly turnId: string;
  readonly stepIndex: number;
}

const placesByRuns = new WeakMap<object, ReadonlyMap<string, RunPlace>>();

/**
 * Each turn-owned run's place. A run's step is the count of runs its turn requested before it,
 * which a complete view holds. A run a context change owns has no step.
 */
function runPlaces(view: SessionView): ReadonlyMap<string, RunPlace> {
  const cached = placesByRuns.get(view.runs);
  if (cached !== undefined) return cached;
  const places = new Map<string, RunPlace>();
  const steps = new Map<string, number>();
  for (const row of Object.values(view.runs)) {
    if (!("turnId" in row.owner)) continue;
    const { turnId } = row.owner;
    const stepIndex = steps.get(turnId) ?? 0;
    steps.set(turnId, stepIndex + 1);
    places.set(row.runId, { stepIndex, turnId });
  }
  placesByRuns.set(view.runs, places);
  return places;
}

export function runPlace(view: SessionView, runId: string | undefined): RunPlace | undefined {
  return runId === undefined ? undefined : runPlaces(view).get(runId);
}

/** A turn's latest step as of a position: the place of its last run introduced by then. */
export function turnStepAt(view: SessionView, turnId: string, position = Infinity): number {
  let step = 0;
  for (const [runId, place] of runPlaces(view)) {
    const introducedAt = view.runs[runId]?.introducedAt ?? Infinity;
    if (place.turnId === turnId && introducedAt <= position) step = place.stepIndex;
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

/**
 * Where a call stands, as the stream reports it. A task call runs until its `call.settled`, not
 * until the receipt the model reads.
 */
export type SessionCallStatus =
  | "running"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

const SETTLED_CALL_STATUSES: ReadonlySet<SessionCallStatus> = new Set([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

export function isSettledCallStatus(status: SessionCallStatus): boolean {
  return SETTLED_CALL_STATUSES.has(status);
}

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
 * A call's status as the stream reported it. A call waits on input while its own approval is
 * open; a task call's outcome maps to the task call statuses.
 */
export function reportedCallStatus(
  view: SessionView,
  callId: string,
): SessionCallStatus | undefined {
  const row = view.calls[callId];
  if (row === undefined) return undefined;
  if (row.status !== "settled") {
    if (row.taskId !== undefined) return "running";
    const approval = ownApproval(view, callId);
    if (approval?.status === "open") return "awaiting-input";
    if (approval?.outcome === "declined") return "rejected";
    if (approval?.outcome === "withdrawn") return "cancelled";
    return "running";
  }
  switch (row.outcome) {
    case "completed":
      return "completed";
    case "interrupted":
      return "cancelled";
    case "rejected":
      return row.taskId === undefined ? "rejected" : "failed";
    default:
      return "failed";
  }
}

/**
 * A call's status for a reader. A call still running when its turn ended, or when the reader's
 * stream stopped (`streaming: false`), reads as `interrupted`; a task call runs past its turn.
 */
export function callStatus(
  view: SessionView,
  callId: string,
  options: { readonly streaming?: boolean } = {},
): SessionCallStatus | "interrupted" | undefined {
  const status = reportedCallStatus(view, callId);
  const row = view.calls[callId];
  if (row === undefined || status !== "running" || row.taskId !== undefined) return status;
  const turnId = callTurn(view, row);
  const turn = turnId === undefined ? undefined : view.turns[turnId];
  if (options.streaming === false || turn?.status === "settled") return "interrupted";
  return status;
}

/** Why a call failed, as its settlement said. */
export function callError(view: SessionView, callId: string): ActionResultError | undefined {
  return view.calls[callId]?.error;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** One call that started or reached a task, settled by its `call.settled`. */
export interface ConversationTaskCall {
  readonly callId: string;
  readonly turnId: string;
  readonly status: "working" | "completed" | "failed" | "cancelled";
  /** The call's result; present only when `status` is `"completed"`. */
  readonly output?: JsonValue;
  /** Why the call failed; present only when `status` is `"failed"`. */
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
  const turnId = callTurn(view, row) ?? "";
  if (row.status !== "settled") return { callId: row.callId, status: "working", turnId };
  if (row.outcome === "completed") {
    const output = callOutputSource(view, row.callId)?.output;
    return output === undefined
      ? { callId: row.callId, status: "completed", turnId }
      : { callId: row.callId, output, status: "completed", turnId };
  }
  if (row.outcome === "interrupted") return { callId: row.callId, status: "cancelled", turnId };
  return row.error === undefined
    ? { callId: row.callId, status: "failed", turnId }
    : { callId: row.callId, error: { message: row.error.message }, status: "failed", turnId };
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

export interface ReaderInput {
  readonly request: InputRequest;
  readonly turnId: string;
  readonly stepIndex: number;
  /** The task whose run asks, when a task asks. */
  readonly taskId?: string;
  /** The call a relayed request serves. */
  readonly callId?: string;
  readonly status: "open" | "settled";
  readonly response?: InputResponse;
  readonly outcome?: InputResolutionOutcome;
  /** Answers submitted to the request that haven't settled yet. */
  readonly pendingResponseIds?: readonly string[];
}

/** The private request kind of a public one; a kind readers don't show has none. */
function inputKindOf(request: InteractionRequest): InputRequest["kind"] | undefined {
  if (request.kind === "approval") return "tool-approval";
  if (request.kind === "budget") return "session-limit";
  if (request.kind === "question") return "question";
  return undefined;
}

const OPTION_STYLES: ReadonlySet<string> = new Set(["primary", "danger", "default"]);

/**
 * A request as an `InputRequest`. The public request carries no call action: the subject's call
 * names it, or a relayed request's origin does, since the asker's call is in another session.
 */
function inputRequestOf(
  view: SessionView,
  row: InteractionRow,
  kind: InputRequest["kind"],
): InputRequest {
  const { request, subject } = row;
  const callId = "callId" in subject ? subject.callId : row.interactionId;
  const asked = row.origin?.call;
  const callRow = view.calls[callId];
  const input = asked?.input ?? callRow?.input;
  const rebuilt: Mutable<InputRequest> = {
    action: {
      callId: asked?.callId ?? callId,
      input: isJsonObjectValue(input) ? input : {},
      kind: "tool-call",
      toolName:
        asked?.name ??
        callRow?.capability.name ??
        (kind === "session-limit" ? SESSION_LIMIT_CONTINUATION_TOOL_NAME : kind),
    },
    kind,
    prompt: request.prompt,
    requestId: row.interactionId,
  };
  if (request.allowFreeform !== undefined) rebuilt.allowFreeform = request.allowFreeform;
  if (
    request.display === "confirmation" ||
    request.display === "select" ||
    request.display === "text"
  )
    rebuilt.display = request.display;
  if (request.options !== undefined) {
    rebuilt.options = request.options.map((option) => {
      const entry: Mutable<InputOption> = { id: option.id, label: option.label };
      if (option.description !== undefined) entry.description = option.description;
      if (option.style !== undefined && OPTION_STYLES.has(option.style))
        entry.style = option.style as InputOption["style"];
      return entry;
    });
  }
  return rebuilt;
}

/** The outcome an `InputResolution` reports for a settled request. */
function inputOutcomeOf(
  kind: InputRequest["kind"],
  outcome: InteractionOutcome | undefined,
  reason: string | undefined,
): InputResolutionOutcome {
  switch (outcome) {
    case "accepted":
      return kind === "tool-approval" ? "approved" : "answered";
    case "declined":
      return kind === "tool-approval" ? "denied" : "answered";
    case "invalid":
      return "invalid";
    case "withdrawn":
      return reason === SUPERSEDED_BY_MESSAGE ? "ignored" : "cancelled";
    default:
      return "cancelled";
  }
}

function answerOf(
  requestId: string,
  response: { readonly [key: string]: unknown } | undefined,
): InputResponse | undefined {
  if (response === undefined) return undefined;
  const answer: { requestId: string; optionId?: string; text?: string } = { requestId };
  if (typeof response.optionId === "string") answer.optionId = response.optionId;
  if (typeof response.text === "string") answer.text = response.text;
  return answer.optionId === undefined && answer.text === undefined ? undefined : answer;
}

/** The turn a request holds, its step when it opened, and the task whose run asks. */
function placeOf(view: SessionView, row: InteractionRow) {
  const owner = interactionOwner(view, row);
  const turnId = owner.turnId ?? view.session.latestTurnId ?? "turn_0";
  return {
    stepIndex: turnStepAt(view, turnId, row.introducedAt),
    taskId: owner.taskId,
    turnId,
  };
}

/** One approval, question, or budget prompt as a reader shows it; a sign-in has none. */
export function readerInput(view: SessionView, interactionId: string): ReaderInput | undefined {
  const row = view.interactions[interactionId];
  if (row === undefined) return undefined;
  const kind = inputKindOf(row.request);
  if (kind === undefined) return undefined;
  const { stepIndex, taskId, turnId } = placeOf(view, row);
  const input: Mutable<ReaderInput> = {
    request: inputRequestOf(view, row, kind),
    status: row.status,
    stepIndex,
    turnId,
  };
  if (taskId !== undefined) input.taskId = taskId;
  // A question, or a request from another session, answers elsewhere: it serves a call.
  if ((row.origin !== undefined || kind === "question") && "callId" in row.subject)
    input.callId = row.subject.callId;
  if (row.status === "settled") {
    input.outcome = inputOutcomeOf(kind, row.outcome, row.reason);
    const answer = answerOf(interactionId, row.response);
    if (answer !== undefined) input.response = answer;
  }
  const pending = Object.values(view.responses)
    .filter((response) => response.interactionId === interactionId && response.status !== "settled")
    .map((response) => response.responseId);
  if (pending.length > 0) input.pendingResponseIds = pending;
  return input;
}

/** Every approval, question, and budget prompt, by request id. */
export function readerInputs(view: SessionView): Readonly<Record<string, ReaderInput>> {
  const inputs: Record<string, ReaderInput> = {};
  for (const interactionId of Object.keys(view.interactions)) {
    const input = readerInput(view, interactionId);
    if (input !== undefined) inputs[interactionId] = input;
  }
  return inputs;
}

/** A request the session still waits on, as the shared tables show it. */
export interface OpenRequest {
  readonly request: InputRequest;
  /** The call a relayed request serves. */
  readonly callId?: string;
  /** The task whose run asks, when a task asks. */
  readonly taskId?: string;
  /** The turn the request holds, when a turn owns it. */
  readonly turnId?: string;
}

/**
 * The approvals, questions, and budget prompts the session still waits on, oldest first: the
 * server's one source for whether a request is open.
 */
export function openRequests(view: SessionView | undefined): readonly OpenRequest[] {
  if (view === undefined) return [];
  return openInteractions(view).flatMap((row) => {
    const kind = inputKindOf(row.request);
    if (kind === undefined) return [];
    const open: Mutable<OpenRequest> = { request: inputRequestOf(view, row, kind) };
    const { taskId, turnId } = interactionOwner(view, row);
    if (taskId !== undefined) open.taskId = taskId;
    if (turnId !== undefined) open.turnId = turnId;
    if ((row.origin !== undefined || kind === "question") && "callId" in row.subject)
      open.callId = row.subject.callId;
    return [open];
  });
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

/** A sign-in as a reader shows it: what to do, where, and how it ended. */
export interface ReaderSignIn {
  readonly attemptId: string;
  readonly name: string;
  readonly prompt: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly taskId?: string;
  /** Who the sign-in is for: the principal that started it. */
  readonly principalId?: string;
  /** The approval response whose responder signs in. */
  readonly responseId?: string;
  readonly signIn?: SignInChallenge;
  readonly status: "required" | AuthorizationOutcome;
  /** The sign-in resumes its work through a callback, rather than inline. */
  readonly awaitsCallback?: true;
}

export function signInOutcomeOf(outcome: InteractionOutcome | undefined): AuthorizationOutcome {
  if (outcome === "accepted") return "authorized";
  if (outcome === "expired") return "timed-out";
  if (outcome === "failed" || outcome === "abandoned") return "failed";
  return "declined";
}

export function readerSignIn(view: SessionView, attemptId: string): ReaderSignIn | undefined {
  const row = view.interactions[attemptId];
  if (row === undefined || row.request.kind !== "sign-in") return undefined;
  const { stepIndex, taskId, turnId } = placeOf(view, row);
  const signIn: Mutable<ReaderSignIn> = {
    attemptId,
    name: row.request.signIn?.name ?? attemptId,
    prompt: row.request.prompt,
    status: row.status === "open" ? "required" : signInOutcomeOf(row.outcome),
    stepIndex,
    turnId,
  };
  const owner = taskId ?? ("taskId" in row.subject ? row.subject.taskId : undefined);
  if (owner !== undefined) signIn.taskId = owner;
  const principalId = row.audience?.principalIds[0];
  if (principalId !== undefined) signIn.principalId = principalId;
  if ("responseId" in row.subject) signIn.responseId = row.subject.responseId;
  if (row.request.signIn !== undefined) signIn.signIn = row.request.signIn;
  if (row.request.signIn?.callbackUrl !== undefined) signIn.awaitsCallback = true;
  return signIn;
}

/** Sign-ins the session still waits on, in the order they opened. */
export function openSignIns(view: SessionView | undefined): readonly ReaderSignIn[] {
  if (view === undefined) return [];
  return openInteractions(view, { kind: "sign-in" }).flatMap(
    (row) => readerSignIn(view, row.interactionId) ?? [],
  );
}

/** Whether the shared tables show the session waiting on a sign-in. */
export function waitsOnSignIn(view: SessionView | undefined): boolean {
  return view !== undefined && openInteractions(view, { kind: "sign-in" }).length > 0;
}

/** The run a turn-owned run's part belongs to, for readers that place content. */
export function partRunPlace(view: SessionView, partId: string): RunPlace | undefined {
  const part = view.parts[partId];
  return part === undefined ? undefined : runPlace(view, part.runId);
}

/** The turn a run serves, for readers that only need the turn. */
export function runTurnOf(view: SessionView, runId: string): string | undefined {
  const row = view.runs[runId];
  return row === undefined ? undefined : runTurn(view, row);
}
