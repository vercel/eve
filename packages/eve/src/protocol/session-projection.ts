import { SESSION_LIMIT_CONTINUATION_TOOL_NAME } from "#protocol/budget-request.js";
import type {
  ActionResultError,
  AuthorizationOutcome,
  InputResolutionOutcome,
} from "#protocol/message.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type {
  InteractionOpenedData,
  InteractionOutcome,
  InteractionRequest,
  SignInChallenge,
} from "#protocol/session-events/families/interaction.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { interactionOwner, openInteractions } from "#protocol/session-projection/selectors.js";
import type { InputOption, InputRequest, InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";
import { isJsonObjectValue } from "#shared/json.js";

// The session's private lifecycle fold: turns, runs, calls, requests, tasks, and sign-ins, with
// the coordinates the v26 work events still carry. Execution reads it; it folds the v27 facts the
// session publishes and the v26 work events not yet moved. It reads only the protocol and stays
// free of runtime dependencies, so workflow bodies import it. Public readers fold the v27 view.

export interface SessionTurn {
  readonly turnId: string;
  readonly sequence: number;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  /** The open turn is parked, holding on its tasks or on a person: a sign-in, approval, or question. */
  readonly waiting?: boolean;
  /** The step the turn's latest `step.started` opened; absent before its first. */
  readonly stepIndex?: number;
  /** The model run that step requested. */
  readonly runId?: string;
  /** The turn streamed assistant output, so steering can no longer restart it. */
  readonly outputStarted?: boolean;
  /** The content parts that reply, in order: what `turn.settled.reply` lists. */
  readonly reply?: readonly string[];
}

export interface SessionInput {
  readonly request: InputRequest;
  readonly sequence: number;
  readonly turnId: string;
  readonly stepIndex: number;
  /** The task whose run asks, when a task asks. */
  readonly taskId?: string;
  /** The call a relayed request serves. */
  readonly callId?: string;
  /** `responded` is client-only: an answer this client sent that the stream hasn't settled. */
  readonly status: "open" | "responded" | "settled";
  readonly response?: InputResponse;
  readonly outcome?: string;
  /** Answers submitted to the request that haven't settled yet. */
  readonly pendingResponseIds?: readonly string[];
}

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
  /** Calls in the order they started or reached the task. */
  readonly calls: Readonly<Record<string, ConversationTaskCall>>;
}

/**
 * Where a call stands, as the stream reports it. A task call runs until its `call.settled`,
 * not until the receipt the model reads.
 */
export type SessionCallStatus =
  | "running"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

interface SessionCallFields {
  readonly callId: string;
  /** The tool, subagent, or skill the call invokes. */
  readonly name: string;
  readonly turnId: string;
  readonly stepIndex: number;
  /** The approval request the call awaits, or awaited. */
  readonly requestId?: string;
}

/**
 * One call the session made. A call that started or reached a task keeps only the link to it:
 * the task's call record is where it stands, so the projection holds each outcome once.
 */
export type SessionCall = SessionCallFields &
  (
    | {
        readonly status: SessionCallStatus;
        readonly error?: ActionResultError;
        readonly taskId?: undefined;
      }
    | { readonly taskId: string; readonly status?: undefined; readonly error?: undefined }
  );

/** A call the session settles from its own results, not through a task. */
type LocalCall = Extract<SessionCall, { readonly status: SessionCallStatus }>;

export interface SessionAuthorization {
  /** The attempt's `attemptId`, or its connection name from a writer that sent none. */
  readonly attemptId: string;
  readonly name: string;
  readonly sequence: number;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly taskId?: string;
  readonly principalId?: string;
  /** The approval candidate whose responder signs in. */
  readonly candidateId?: string;
  readonly status: "required" | AuthorizationOutcome;
  /** The sign-in resumes its work through a callback, rather than inline. */
  readonly awaitsCallback?: true;
}

export interface SessionProjection {
  /** `session.started` was published. */
  readonly started?: true;
  /** The session ended (`session.ended`). */
  readonly ended?: true;
  readonly activeTurnId?: string;
  /** The most recent turn, open or closed. Pruning keeps it, so the session's end can name it. */
  readonly latestTurn?: Pick<SessionTurn, "sequence" | "turnId">;
  /** The sequence the next turn takes. */
  readonly nextSequence: number;
  /**
   * Lines written to the session's stream so far: the position of the next one. The writer
   * counts them, so every checkpoint knows its position without reading the stream.
   */
  readonly position?: number;
  readonly turns: Readonly<Record<string, SessionTurn>>;
  /** By `requestId`. */
  readonly inputs: Readonly<Record<string, SessionInput>>;
  /** By `taskId`. */
  readonly tasks: Readonly<Record<string, ConversationTask>>;
  /** By `callId`. */
  readonly calls: Readonly<Record<string, SessionCall>>;
  /** By `attemptId`. */
  readonly authorizations: Readonly<Record<string, SessionAuthorization>>;
  /** Open model runs, by `runId`: what owns each, and a turn's run's step index. */
  readonly runs?: Readonly<Record<string, SessionRun>>;
  /** Runs and context changes minted so far, so their ids are deterministic. */
  readonly counters?: { readonly runs: number; readonly changes: number };
  /** The public view, kept with operational retention, for observers and server readers. */
  readonly view?: SessionView;
}

/** One open model run: the turn it serves with its step index, or the context change it summarizes. */
export interface SessionRun {
  readonly turnId?: string;
  readonly stepIndex?: number;
  readonly changeId?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function initialSessionProjection(): SessionProjection {
  return {
    authorizations: {},
    calls: {},
    inputs: {},
    nextSequence: 0,
    tasks: {},
    turns: {},
  };
}

function updateTurn<S extends SessionProjection>(
  state: S,
  turnId: string,
  update: (turn: SessionTurn) => SessionTurn,
): S {
  const turn = state.turns[turnId];
  if (turn === undefined) return state;
  const next = update(turn);
  return next === turn ? state : { ...state, turns: { ...state.turns, [turnId]: next } };
}

function putTask<S extends SessionProjection>(state: S, task: ConversationTask): S {
  return state.tasks[task.taskId] === task
    ? state
    : { ...state, tasks: { ...state.tasks, [task.taskId]: task } };
}

function putTaskCall(task: ConversationTask, call: ConversationTaskCall): ConversationTask {
  return task.calls[call.callId] === call
    ? task
    : { ...task, calls: { ...task.calls, [call.callId]: call } };
}

function putCall<S extends SessionProjection>(state: S, call: SessionCall): S {
  return state.calls[call.callId] === call
    ? state
    : { ...state, calls: { ...state.calls, [call.callId]: call } };
}

function updateTask<S extends SessionProjection>(
  state: S,
  taskId: string,
  update: (task: ConversationTask) => ConversationTask,
): S {
  const task = state.tasks[taskId];
  if (task === undefined) return state;
  const next = update(task);
  return putTask(state, next);
}

function updateCall<S extends SessionProjection>(
  state: S,
  callId: string,
  update: (call: SessionCall) => SessionCall,
): S {
  const call = state.calls[callId];
  if (call === undefined) return state;
  const next = update(call);
  return putCall(state, next);
}

const SETTLED_CALL_STATUSES: ReadonlySet<SessionCallStatus> = new Set([
  "completed",
  "failed",
  "rejected",
  "cancelled",
]);

export function isSettledCallStatus(status: SessionCallStatus): boolean {
  return SETTLED_CALL_STATUSES.has(status);
}

function settleCall(call: SessionCall, status: SessionCallStatus, error?: ActionResultError) {
  if (call.taskId !== undefined || isSettledCallStatus(call.status)) return call;
  const { requestId: _requestId, error: _error, ...rest } = call;
  const settled: Mutable<LocalCall> = { ...rest, status };
  if (call.requestId !== undefined) settled.requestId = call.requestId;
  if (error !== undefined) settled.error = error;
  return settled;
}

/** The status an approval's resolution leaves its call in. */
function callStatusAfterApproval(outcome: InputResolutionOutcome | "approved" | "cancelled") {
  switch (outcome) {
    case "approved":
      return "running";
    case "denied":
      return "rejected";
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

/**
 * Folds one stream event into a session's lifecycle. Events this fold doesn't track, and
 * client-only events, return `state` unchanged, so callers may pass any event through it.
 */
export function foldSession<S extends SessionProjection>(
  state: S,
  event: SessionEvent | { readonly type: string },
): S {
  const typed = event as SessionEvent;
  switch (typed.type) {
    case "session.started":
      return state.started ? state : { ...state, started: true };
    case "turn.started": {
      const { turnId } = typed.data;
      const sequence = turnSequence(turnId) ?? state.nextSequence;
      const turn: SessionTurn = { turnId, sequence, status: "active" };
      return {
        ...state,
        activeTurnId: turnId,
        latestTurn:
          state.latestTurn !== undefined && state.latestTurn.sequence > sequence
            ? state.latestTurn
            : { turnId, sequence },
        nextSequence: Math.max(state.nextSequence, sequence + 1),
        turns: { ...state.turns, [turnId]: turn },
      };
    }
    case "turn.paused":
      return updateTurn(state, typed.data.turnId, (turn) =>
        turn.status === "active" && !turn.waiting ? { ...turn, waiting: true } : turn,
      );
    case "turn.resumed":
      return updateTurn(state, typed.data.turnId, (turn) => {
        if (!turn.waiting) return turn;
        const { waiting: _waiting, ...rest } = turn;
        return rest;
      });
    case "turn.settled": {
      const { outcome, turnId } = typed.data;
      const status =
        outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "cancelled";
      const turn = state.turns[turnId];
      const { waiting: _waiting, ...rest } = turn ?? {
        sequence: turnSequence(turnId) ?? state.nextSequence,
        turnId,
      };
      return {
        ...state,
        activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
        turns: { ...state.turns, [turnId]: { ...rest, status } },
      };
    }
    case "model.requested": {
      const { owner, runId } = typed.data;
      const counters = state.counters ?? { changes: 0, runs: 0 };
      const next = { ...state, counters: { ...counters, runs: counters.runs + 1 } };
      if ("changeId" in owner) {
        return { ...next, runs: { ...state.runs, [runId]: { changeId: owner.changeId } } };
      }
      const turn = state.turns[owner.turnId];
      const stepIndex = turn?.stepIndex === undefined ? 0 : turn.stepIndex + 1;
      const run: SessionRun = { stepIndex, turnId: owner.turnId };
      return updateTurn(
        { ...next, runs: { ...state.runs, [runId]: run } },
        owner.turnId,
        (current) => ({ ...current, runId, stepIndex }),
      );
    }
    case "model.started": {
      const turnId = state.runs?.[typed.data.runId]?.turnId;
      if (turnId === undefined) return state;
      return updateTurn(state, turnId, (turn) => {
        if (!turn.waiting) return turn;
        const { waiting: _waiting, ...rest } = turn;
        return rest;
      });
    }
    case "model.settled": {
      if (state.runs?.[typed.data.runId] === undefined) return state;
      const { [typed.data.runId]: _settled, ...runs } = state.runs;
      return { ...state, runs };
    }
    case "content.delta": {
      const { delta, kind } = typed.data;
      if (kind !== "text" || delta.length === 0) return state;
      return markOutputStarted(state, typed.scope?.runId);
    }
    case "content.completed": {
      const { kind, partId, phase, runId, value } = typed.data;
      const output =
        kind === "result" || (kind === "text" && typeof value === "string" && value.length > 0);
      const next = output ? markOutputStarted(state, runId) : state;
      if (phase !== "reply") return next;
      const turnId = next.runs?.[runId]?.turnId;
      if (turnId === undefined) return next;
      return updateTurn(next, turnId, (turn) => ({
        ...turn,
        reply: [...(turn.reply ?? []), partId],
      }));
    }
    case "context.started": {
      const counters = state.counters ?? { changes: 0, runs: 0 };
      return { ...state, counters: { ...counters, changes: counters.changes + 1 } };
    }
    case "context.settled":
      if (typed.data.kind !== "clear" || typed.data.outcome !== "completed") return state;
      return {
        ...state,
        calls: Object.fromEntries(
          Object.entries(state.calls).filter(([, call]) => call.taskId !== undefined),
        ),
      };
    case "session.ended": {
      const { activeTurnId: _activeTurnId, ...rest } = state;
      return { ...rest, ended: true } as S;
    }
    case "call.requested": {
      const { callId, capability, owner } = typed.data;
      if (state.calls[callId] !== undefined) return state;
      const at = "runId" in owner ? state.runs?.[owner.runId] : state.calls[owner.callId];
      const turnId = at?.turnId ?? state.activeTurnId ?? turnCoordinates(state).turnId;
      const stepIndex = at?.stepIndex ?? state.turns[turnId]?.stepIndex ?? 0;
      return putCall(state, {
        callId,
        name: capability.name,
        status: "running",
        stepIndex,
        turnId,
      });
    }
    case "call.started": {
      const { callId, taskId } = typed.data;
      const call = state.calls[callId];
      if (taskId === undefined || call === undefined || call.taskId === taskId) return state;
      const task = state.tasks[taskId];
      if (task === undefined) return state;
      const next = putTask(
        state,
        putTaskCall(task, { callId, turnId: call.turnId, status: "working" }),
      );
      const linked: Mutable<SessionCall> = {
        callId,
        name: call.name,
        stepIndex: call.stepIndex,
        taskId,
        turnId: call.turnId,
      };
      if (call.requestId !== undefined) linked.requestId = call.requestId;
      return putCall(next, linked);
    }
    case "call.settled": {
      const { callId, error, outcome, outputOf } = typed.data;
      const call = state.calls[callId];
      if (call === undefined) return state;
      if (call.taskId !== undefined)
        return updateTask(state, call.taskId, (task) => {
          const running = task.calls[callId];
          if (running === undefined || running.status !== "working") return task;
          const status: ConversationTaskCall["status"] =
            outcome === "completed"
              ? "completed"
              : outcome === "interrupted"
                ? "cancelled"
                : "failed";
          const output =
            typed.data.output !== undefined
              ? typed.data.output
              : outputOf === undefined
                ? undefined
                : task.calls[outputOf.callId]?.output;
          const settled = { callId, turnId: call.turnId, status };
          return putTaskCall(
            task,
            status === "completed" && output !== undefined
              ? { ...settled, output }
              : status === "failed" && error !== undefined
                ? { ...settled, error }
                : settled,
          );
        });
      const status: SessionCallStatus =
        outcome === "interrupted" ? "cancelled" : outcome === "abandoned" ? "failed" : outcome;
      return updateCall(state, callId, (current) => settleCall(current, status, error));
    }
    case "task.started": {
      const { kind, name, taskId } = typed.data;
      if (state.tasks[taskId] !== undefined) return state;
      return putTask(state, { taskId, name, kind: kind === "agent" ? "agent" : "tool", calls: {} });
    }
    case "interaction.opened": {
      const { audience, interactionId, origin, request, subject } = typed.data;
      const turnId =
        typed.scope?.turnId ??
        ("turnId" in subject ? subject.turnId : undefined) ??
        state.activeTurnId ??
        turnCoordinates(state).turnId;
      const turn = state.turns[turnId];
      const at = {
        sequence: turn?.sequence ?? turnSequence(turnId) ?? state.nextSequence,
        stepIndex: turn?.stepIndex ?? 0,
        turnId,
      };
      const taskId = typed.scope?.taskId ?? ("taskId" in subject ? subject.taskId : undefined);
      if (request.kind === "sign-in") {
        if (state.authorizations[interactionId] !== undefined) return state;
        const authorization: Mutable<SessionAuthorization> = {
          attemptId: interactionId,
          name: request.signIn?.name ?? interactionId,
          status: "required",
          ...at,
        };
        if (taskId !== undefined) authorization.taskId = taskId;
        const principalId = audience?.principalIds[0];
        if (principalId !== undefined) authorization.principalId = principalId;
        if ("responseId" in subject) authorization.candidateId = subject.responseId;
        if (request.signIn?.callbackUrl !== undefined) authorization.awaitsCallback = true;
        return {
          ...state,
          authorizations: { ...state.authorizations, [interactionId]: authorization },
        };
      }
      if (state.inputs[interactionId] !== undefined) return state;
      const kind = inputKindOf(request);
      if (kind === undefined) return state;
      // A question, or a request from another session, answers elsewhere: it serves a call or a
      // task. An approval without an origin is this session's own, about its own call.
      const relayed = origin !== undefined || kind === "question";
      const callId = "callId" in subject ? subject.callId : interactionId;
      // A relayed request is about the asker's call, which this session's tables don't hold.
      const asked = origin?.call;
      const input: Mutable<SessionInput> = {
        request: inputRequestOf(interactionId, request, kind, {
          callId: asked?.callId ?? callId,
          input: asked?.input,
          toolName:
            asked?.name ??
            state.calls[callId]?.name ??
            (kind === "session-limit" ? SESSION_LIMIT_CONTINUATION_TOOL_NAME : kind),
        }),
        status: "open",
        ...at,
      };
      if (taskId !== undefined) input.taskId = taskId;
      if (relayed && "callId" in subject) input.callId = subject.callId;
      let next: S = { ...state, inputs: { ...state.inputs, [interactionId]: input } };
      if (kind === "tool-approval" && !relayed) {
        next = updateCall(next, callId, (call) =>
          call.taskId !== undefined || isSettledCallStatus(call.status)
            ? call
            : { ...call, requestId: interactionId, status: "awaiting-input" },
        );
      }
      return next;
    }
    case "response.submitted": {
      const { interactionId, responseId } = typed.data;
      const current = state.inputs[interactionId];
      if (current === undefined || current.status === "settled") return state;
      const pendingResponseIds = [...(current.pendingResponseIds ?? []), responseId];
      return {
        ...state,
        inputs: { ...state.inputs, [interactionId]: { ...current, pendingResponseIds } },
      };
    }
    // An answer the server refused, or that never applied, leaves its request answerable again.
    case "response.settled": {
      const { outcome, responseId } = typed.data;
      const entry = Object.entries(state.inputs).find(([, input]) =>
        input.pendingResponseIds?.includes(responseId),
      );
      if (entry === undefined) return state;
      const [interactionId, current] = entry;
      const remaining = current.pendingResponseIds?.filter((id) => id !== responseId) ?? [];
      const { pendingResponseIds: _pending, response: _response, ...rest } = current;
      const reopened: Mutable<SessionInput> =
        outcome !== "applied" && current.status === "responded" && remaining.length === 0
          ? { ...rest, status: "open" }
          : { ...current };
      if (remaining.length > 0) reopened.pendingResponseIds = remaining;
      else delete reopened.pendingResponseIds;
      return { ...state, inputs: { ...state.inputs, [interactionId]: reopened } };
    }
    case "interaction.settled": {
      const { interactionId, outcome, reason, response } = typed.data;
      const attempt = state.authorizations[interactionId];
      if (attempt !== undefined) {
        if (attempt.status !== "required") return state;
        return {
          ...state,
          authorizations: {
            ...state.authorizations,
            [interactionId]: { ...attempt, status: signInOutcomeOf(outcome) },
          },
        };
      }
      const current = state.inputs[interactionId];
      if (current === undefined || current.status === "settled") return state;
      const resolved = inputOutcomeOf(current.request.kind, outcome, reason);
      const settled: Mutable<SessionInput> = { ...current, outcome: resolved, status: "settled" };
      const answer = answerOf(interactionId, response);
      if (answer !== undefined) settled.response = answer;
      const next = { ...state, inputs: { ...state.inputs, [interactionId]: settled } };
      return settleApprovalCall(next, current, resolved);
    }
    default:
      return state;
  }
}

/** A turn id's sequence: `turn_${n}`. */
function turnSequence(turnId: string): number | undefined {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? undefined : Number(match[1]);
}

/** The turn a run serves streamed output, so steering can no longer restart it. */
function markOutputStarted<S extends SessionProjection>(state: S, runId: string | undefined): S {
  const turnId = runId === undefined ? state.activeTurnId : state.runs?.[runId]?.turnId;
  if (turnId === undefined) return state;
  return updateTurn(state, turnId, (turn) =>
    turn.outputStarted ? turn : { ...turn, outputStarted: true },
  );
}

/** The id the session's next model run takes. */
export function nextRunId(state: SessionProjection): string {
  return `run_${String(state.counters?.runs ?? 0)}`;
}

/** The id the session's next context change takes. */
export function nextChangeId(state: SessionProjection): string {
  return `change_${String(state.counters?.changes ?? 0)}`;
}

/** The open run that serves a turn: its latest run. */
export function openRunOf(state: SessionProjection, turnId: string): string | undefined {
  let found: string | undefined;
  for (const [runId, run] of Object.entries(state.runs ?? {})) {
    if (run.turnId === turnId) found = runId;
  }
  return found;
}

function isRelayed(request: { readonly callId?: string; readonly taskId?: string }): boolean {
  return request.callId !== undefined || request.taskId !== undefined;
}

/** The private request kind of a public one; a kind this fold doesn't run has none. */
function inputKindOf(request: InteractionRequest): InputRequest["kind"] | undefined {
  if (request.kind === "approval") return "tool-approval";
  if (request.kind === "budget") return "session-limit";
  if (request.kind === "question") return "question";
  return undefined;
}

const OPTION_STYLES: ReadonlySet<string> = new Set(["primary", "danger", "default"]);

/**
 * A request as execution reads it. The public request carries no call action: the subject's call
 * names it, and its input stays on the call row.
 */
function inputRequestOf(
  requestId: string,
  request: InteractionRequest,
  kind: InputRequest["kind"],
  action: { readonly callId: string; readonly input?: JsonValue; readonly toolName: string },
): InputRequest {
  const rebuilt: Mutable<InputRequest> = {
    action: {
      callId: action.callId,
      input: isJsonObjectValue(action.input) ? action.input : {},
      kind: "tool-call",
      toolName: action.toolName,
    },
    kind,
    prompt: request.prompt,
    requestId,
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

/** The v26-shaped outcome execution and the client still read for a settled request. */
function inputOutcomeOf(
  kind: InputRequest["kind"],
  outcome: InteractionOutcome,
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

/** Why a request nobody answered closed when a message steered its turn instead. */
export const SUPERSEDED_BY_MESSAGE = "superseded-by-message";

function signInOutcomeOf(outcome: InteractionOutcome): AuthorizationOutcome {
  if (outcome === "accepted") return "authorized";
  if (outcome === "expired") return "timed-out";
  if (outcome === "failed" || outcome === "abandoned") return "failed";
  return "declined";
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

function settleApprovalCall<S extends SessionProjection>(
  state: S,
  input: SessionInput,
  outcome: InputResolutionOutcome | "approved" | "cancelled",
): S {
  if (input.request.kind !== "tool-approval" || isRelayed(input)) return state;
  const status = callStatusAfterApproval(outcome);
  if (status === undefined) return state;
  return updateCall(state, input.request.action.callId, (call) => {
    if (call.status !== "awaiting-input" || call.requestId !== input.request.requestId) return call;
    return status === "running" ? { ...call, status } : settleCall(call, status);
  });
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The coordinates the active turn's events carry, or the next turn's when none is open. */
export function turnCoordinates(state: SessionProjection): {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
} {
  const turn = state.activeTurnId === undefined ? undefined : state.turns[state.activeTurnId];
  if (turn !== undefined) {
    return { sequence: turn.sequence, stepIndex: turn.stepIndex ?? 0, turnId: turn.turnId };
  }
  return { sequence: state.nextSequence, stepIndex: 0, turnId: `turn_${state.nextSequence}` };
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

/** Where a turn's events go: its sequence and its latest step, from the private turn record. */
export function turnCoordinatesOf(
  state: SessionProjection,
  turnId: string,
): { readonly sequence: number; readonly stepIndex: number; readonly turnId: string } {
  const turn = state.turns[turnId];
  return {
    sequence: turn?.sequence ?? turnSequence(turnId) ?? state.nextSequence,
    stepIndex: turn?.stepIndex ?? 0,
    turnId,
  };
}

/**
 * The approvals, questions, and budget prompts the session still waits on, oldest first, read
 * from the shared tables: the server's one source for whether a request is open. A question, or
 * a request with an origin, is relayed: it serves a call or a task. An approval without an
 * origin is this session's own, about its own call.
 */
export function openRequests(view: SessionView | undefined): readonly OpenRequest[] {
  if (view === undefined) return [];
  return openInteractions(view).flatMap((row) => {
    const kind = inputKindOf(row.request);
    if (kind === undefined) return [];
    const { subject } = row;
    const callId = "callId" in subject ? subject.callId : row.interactionId;
    const open: Mutable<OpenRequest> = {
      request: inputRequestOf(row.interactionId, row.request, kind, {
        callId,
        toolName: view.calls[callId]?.capability.name ?? kind,
      }),
    };
    const { taskId, turnId } = interactionOwner(view, row);
    if (taskId !== undefined) open.taskId = taskId;
    if (turnId !== undefined) open.turnId = turnId;
    if ((row.origin !== undefined || kind === "question") && "callId" in subject)
      open.callId = subject.callId;
    return [open];
  });
}

/** Whether the shared tables show the session waiting on a sign-in. */
export function waitsOnSignIn(view: SessionView | undefined): boolean {
  return view !== undefined && openInteractions(view, { kind: "sign-in" }).length > 0;
}

/** Inputs awaiting an answer, including requests introduced in earlier turns. */
export function openInputs(state: SessionProjection): readonly SessionInput[] {
  return Object.values(state.inputs).filter((input) => input.status !== "settled");
}

/** Sign-ins the session still waits on. */
export function openSignIns(state: SessionProjection): readonly SessionAuthorization[] {
  return Object.values(state.authorizations).filter((attempt) => attempt.status === "required");
}

/** A sign-in still open, as a reader shows it: what to do, and where. */
export interface OpenSignIn {
  readonly attemptId: string;
  readonly name: string;
  readonly prompt: string;
  /** Who the sign-in is for: the principal that started it. */
  readonly principalId?: string;
  /** The approval response whose responder signs in. */
  readonly responseId?: string;
  readonly signIn?: SignInChallenge;
  readonly taskId?: string;
}

/**
 * Folds a read of a session's events. `observe` sees each event with the projection as it stood
 * before the event, for what a reader shows that the projection doesn't keep.
 */
export async function foldSessionEvents<E extends SessionEvent>(
  events: AsyncIterable<E>,
  observe?: (event: E, before: SessionProjection) => void,
): Promise<{
  readonly projection: SessionProjection;
  /** Each sign-in still open, in the order they opened. */
  readonly signIns: readonly OpenSignIn[];
}> {
  let projection = initialSessionProjection();
  const prompts = new Map<string, OpenSignIn>();
  for await (const event of events) {
    observe?.(event, projection);
    projection = foldSession(projection, event);
    if (event.type === "interaction.opened" && event.data.request.kind === "sign-in")
      prompts.set(event.data.interactionId, openSignInOf(event.data, event.scope?.taskId));
  }
  const signIns = openSignIns(projection).flatMap(
    (attempt) => prompts.get(attempt.attemptId) ?? [],
  );
  return { projection, signIns };
}

function openSignInOf(data: InteractionOpenedData, taskId: string | undefined): OpenSignIn {
  const entry: Mutable<OpenSignIn> = {
    attemptId: data.interactionId,
    name: data.request.signIn?.name ?? data.interactionId,
    prompt: data.request.prompt,
  };
  const principalId = data.audience?.principalIds[0];
  if (principalId !== undefined) entry.principalId = principalId;
  if ("responseId" in data.subject) entry.responseId = data.subject.responseId;
  if (data.request.signIn !== undefined) entry.signIn = data.request.signIn;
  const owner = taskId ?? ("taskId" in data.subject ? data.subject.taskId : undefined);
  if (owner !== undefined) entry.taskId = owner;
  return entry;
}

/** Task calls whose run hasn't settled them. */
export function workingTaskCalls(state: SessionProjection): readonly ConversationTaskCall[] {
  return Object.values(state.tasks).flatMap((task) =>
    Object.values(task.calls).filter((call) => call.status === "working"),
  );
}

/**
 * A call's status for a reader. A call still running when its turn ended, or when the reader's
 * stream stopped (`streaming: false`), reads as `interrupted`; a task call runs past its turn.
 */
export function callStatus(
  state: SessionProjection,
  callId: string,
  options: { readonly streaming?: boolean } = {},
): SessionCallStatus | "interrupted" | undefined {
  const call = state.calls[callId];
  if (call === undefined) return undefined;
  const status = reportedCallStatus(state, call);
  // A task outlives its turn, so only a call the session runs itself is interrupted.
  if (status !== "running" || call.taskId !== undefined) return status;
  const turn = state.turns[call.turnId];
  if (options.streaming === false || (turn !== undefined && turn.status !== "active")) {
    return "interrupted";
  }
  return status;
}

/** A call's status as the stream reported it: a task call's is its task call's. */
export function reportedCallStatus(state: SessionProjection, call: SessionCall): SessionCallStatus {
  if (call.taskId === undefined) return call.status;
  const status = state.tasks[call.taskId]?.calls[call.callId]?.status;
  return status === undefined || status === "working" ? "running" : status;
}

/**
 * Drops what closed, so a long-lived session's stored projection stays proportional to its
 * open work. `keep` names closed requests and calls that execution state still references.
 */
export function pruneSessionProjection(
  state: SessionProjection,
  keep: { readonly requestIds?: Iterable<string>; readonly callIds?: Iterable<string> } = {},
): SessionProjection {
  const keptRequests = new Set(keep.requestIds);
  const keptCalls = new Set(keep.callIds);
  const calls = Object.fromEntries(
    Object.entries(state.calls).filter(
      ([callId, call]) =>
        (!isSettledCallStatus(reportedCallStatus(state, call)) &&
          callStatus(state, callId) !== "interrupted") ||
        keptCalls.has(callId) ||
        (call.requestId !== undefined && keptRequests.has(call.requestId)),
    ),
  );
  // A kept call keeps the decision on its approval.
  for (const call of Object.values(calls)) {
    if (call.requestId !== undefined) keptRequests.add(call.requestId);
  }
  const inputs = Object.fromEntries(
    Object.entries(state.inputs).filter(
      ([requestId, input]) => input.status !== "settled" || keptRequests.has(requestId),
    ),
  );
  // A kept call keeps the task call record that says where it stands.
  const linkedCalls = new Set(
    Object.values(calls).flatMap((call) => (call.taskId === undefined ? [] : [call.callId])),
  );
  const tasks: Record<string, ConversationTask> = {};
  for (const [taskId, task] of Object.entries(state.tasks)) {
    const retained = Object.entries(task.calls).filter(
      ([callId, call]) => call.status === "working" || linkedCalls.has(callId),
    );
    if (retained.length > 0) tasks[taskId] = { ...task, calls: Object.fromEntries(retained) };
  }
  const authorizations = Object.fromEntries(
    Object.entries(state.authorizations).filter(([, attempt]) => attempt.status === "required"),
  );
  const referencedTurns = new Set<string>([
    ...(state.activeTurnId === undefined ? [] : [state.activeTurnId]),
    ...Object.values(inputs).map((input) => input.turnId),
    ...Object.values(calls).map((call) => call.turnId),
    ...Object.values(authorizations).map((attempt) => attempt.turnId),
  ]);
  const turns = Object.fromEntries(
    Object.entries(state.turns).filter(([turnId]) => referencedTurns.has(turnId)),
  );
  return { ...state, authorizations, calls, inputs, tasks, turns };
}
