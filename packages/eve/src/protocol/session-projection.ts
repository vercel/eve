import type {
  ActionResultError,
  ApprovalCandidateOutcome,
  AuthorizationOutcome,
  AuthorizationRequiredStreamEvent,
  InputResolutionOutcome,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";

// The one fold from a session's stream events to its lifecycle: turns, requests, calls, tasks,
// and sign-ins. Server and client readers are meant to share it, so it reads only the public
// protocol and must stay free of runtime dependencies, which also lets workflow bodies import it.

export interface SessionTurn {
  readonly turnId: string;
  readonly sequence: number;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  /** The open turn is parked, holding on its tasks or on a person: a sign-in, approval, or question. */
  readonly waiting?: boolean;
  /** The step the turn's latest `step.started` opened; absent before its first. */
  readonly stepIndex?: number;
  /** The turn streamed assistant output, so steering can no longer restart it. */
  readonly outputStarted?: boolean;
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
}

/** One call that started or reached a task, settled by its `task.settled`. */
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
 * Where a call stands, as the stream reports it. A task call runs until its `task.settled`,
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

/** One responder's decision on an approval, as `approval.candidate` reports it. */
export interface SessionApprovalCandidate {
  readonly candidateId: string;
  readonly requestId: string;
  readonly outcome: ApprovalCandidateOutcome;
}

export interface SessionProjection {
  /** `session.started` was published. */
  readonly started?: true;
  /** The session ended with `session.completed` or `session.failed`. */
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
  /** By `candidateId`. */
  readonly candidates: Readonly<Record<string, SessionApprovalCandidate>>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function initialSessionProjection(): SessionProjection {
  return {
    authorizations: {},
    calls: {},
    candidates: {},
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

function actionName(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return action.name;
    case "subagent-call":
    case "remote-agent-call":
      return action.name;
    case "tool-call":
    case "workflow-tool-call":
      return action.toolName;
  }
}

function resultName(result: RuntimeActionResult): string {
  switch (result.kind) {
    case "load-skill-result":
      return result.name;
    case "subagent-result":
      return result.subagentName;
    default:
      return result.toolName;
  }
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

/** A policy's automatic denial, which writers before `rejected` reported as a failure. */
const TOOL_EXECUTION_DENIED = "TOOL_EXECUTION_DENIED";

/**
 * Folds one stream event into a session's lifecycle. Events this fold doesn't track, and
 * client-only events, return `state` unchanged, so callers may pass any event through it.
 */
export function foldSession<S extends SessionProjection>(
  state: S,
  event: UnstampedMessageStreamEvent | { readonly type: string },
): S {
  const typed = event as UnstampedMessageStreamEvent;
  switch (typed.type) {
    case "session.started":
      return state.started ? state : { ...state, started: true };
    case "turn.started": {
      const { sequence, turnId } = typed.data;
      const turn: SessionTurn = { turnId, sequence, status: "active" };
      return {
        ...state,
        activeTurnId: turnId,
        latestTurn:
          state.latestTurn !== undefined && state.latestTurn.sequence > sequence
            ? state.latestTurn
            : { turnId, sequence },
        nextSequence: Math.max(state.nextSequence, sequence + 1),
        turns: {
          ...state.turns,
          [turnId]: turn,
        },
      };
    }
    case "step.started":
      return updateTurn(state, typed.data.turnId, (turn) => {
        if (!turn.waiting && turn.stepIndex === typed.data.stepIndex) return turn;
        const { waiting: _waiting, ...rest } = turn;
        return { ...rest, stepIndex: typed.data.stepIndex };
      });
    case "turn.waiting":
      return updateTurn(state, typed.data.turnId, (turn) =>
        turn.status === "active" && !turn.waiting ? { ...turn, waiting: true } : turn,
      );
    case "message.appended":
    case "message.completed":
    case "result.completed": {
      const output =
        typed.type === "message.appended"
          ? typed.data.messageDelta.length > 0
          : typed.type === "message.completed"
            ? (typed.data.message?.length ?? 0) > 0
            : true;
      if (!output) return state;
      return updateTurn(state, typed.data.turnId, (turn) =>
        turn.outputStarted ? turn : { ...turn, outputStarted: true },
      );
    }
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed": {
      const { turnId } = typed.data;
      const status =
        typed.type === "turn.completed"
          ? "completed"
          : typed.type === "turn.failed"
            ? "failed"
            : "cancelled";
      const turn = state.turns[turnId];
      const { waiting: _waiting, ...rest } = turn ?? { turnId, sequence: typed.data.sequence };
      return {
        ...state,
        activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
        turns: { ...state.turns, [turnId]: { ...rest, status } },
      };
    }
    case "context.cleared":
      return {
        ...state,
        calls: Object.fromEntries(
          Object.entries(state.calls).filter(([, call]) => call.taskId !== undefined),
        ),
      };
    // Only a turn's end reaches a session boundary, so no turn stays open across one.
    case "session.waiting":
      return state.activeTurnId === undefined ? state : { ...state, activeTurnId: undefined };
    case "session.completed":
    case "session.failed": {
      const { activeTurnId: _activeTurnId, ...rest } = state;
      return { ...rest, ended: true } as S;
    }
    case "actions.requested": {
      let calls: Record<string, SessionCall> | undefined;
      for (const action of typed.data.actions) {
        if (state.calls[action.callId] !== undefined) continue;
        calls ??= { ...state.calls };
        calls[action.callId] = {
          callId: action.callId,
          name: actionName(action),
          turnId: typed.data.turnId,
          stepIndex: typed.data.stepIndex,
          status: "running",
        };
      }
      return calls === undefined ? state : { ...state, calls };
    }
    case "action.result": {
      const { result, status, error } = typed.data;
      const call = state.calls[result.callId];
      // A task call's result is the receipt the model reads; its outcome is its task.settled.
      if (call?.taskId !== undefined) return state;
      const settled =
        status === "rejected" || error?.code === TOOL_EXECUTION_DENIED
          ? "rejected"
          : status === "failed" || result.isError === true
            ? "failed"
            : "completed";
      if (call === undefined) {
        // A result whose call wasn't announced, such as an approved call resuming.
        const unannounced: Mutable<LocalCall> = {
          callId: result.callId,
          name: resultName(result),
          turnId: typed.data.turnId,
          stepIndex: typed.data.stepIndex,
          status: settled,
        };
        if (error !== undefined) unannounced.error = error;
        return putCall(state, unannounced);
      }
      return updateCall(state, result.callId, (current) => settleCall(current, settled, error));
    }
    case "task.started": {
      const { callId, kind, name, taskId, turnId } = typed.data;
      const task = state.tasks[taskId] ?? { taskId, name, kind, calls: {} };
      let next: S = state;
      if (task.calls[callId] === undefined) {
        next = putTask(next, putTaskCall(task, { callId, turnId, status: "working" }));
      }
      const call = next.calls[callId];
      if (call?.taskId === taskId) return next;
      const linked: Mutable<SessionCall> = {
        callId,
        name: call?.name ?? name,
        stepIndex: call?.stepIndex ?? 0,
        taskId,
        turnId: call?.turnId ?? turnId,
      };
      if (call?.requestId !== undefined) linked.requestId = call.requestId;
      return putCall(next, linked);
    }
    case "task.settled": {
      const { callId, error, output, status, taskId } = typed.data;
      return updateTask(state, taskId, (task) => {
        const call = task.calls[callId];
        if (call === undefined || call.status !== "working") return task;
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
    }
    case "input.requested": {
      const inputs = { ...state.inputs };
      let calls: Record<string, SessionCall> | undefined;
      for (const request of typed.data.requests) {
        if (inputs[request.requestId] !== undefined) continue;
        const input: Mutable<SessionInput> = {
          request,
          sequence: typed.data.sequence,
          turnId: typed.data.turnId,
          stepIndex: typed.data.stepIndex,
          status: "open",
        };
        if (typed.data.taskId !== undefined) input.taskId = typed.data.taskId;
        if (typed.data.callId !== undefined) input.callId = typed.data.callId;
        inputs[request.requestId] = input;
        // A relayed request's action is the child's call, not one this session made.
        if (request.kind !== "tool-approval" || isRelayed(typed.data)) continue;
        const { callId, toolName } = request.action;
        calls ??= { ...state.calls };
        const call = calls[callId];
        if (call?.taskId !== undefined) continue;
        if (call !== undefined && isSettledCallStatus(call.status)) continue;
        calls[callId] = {
          ...(call ?? {
            callId,
            name: toolName,
            turnId: typed.data.turnId,
            stepIndex: typed.data.stepIndex,
          }),
          requestId: request.requestId,
          status: "awaiting-input",
        };
      }
      return calls === undefined ? { ...state, inputs } : { ...state, calls, inputs };
    }
    case "approval.candidate": {
      const { candidateId, outcome, requestId } = typed.data;
      state = {
        ...state,
        candidates: { ...state.candidates, [candidateId]: { candidateId, outcome, requestId } },
      };
      const current = state.inputs[typed.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      if (typed.data.outcome === "pending" || current.status === "open") return state;
      const { response: _response, ...rest } = current;
      return {
        ...state,
        inputs: { ...state.inputs, [typed.data.requestId]: { ...rest, status: "open" } },
      };
    }
    case "approval.settled": {
      const current = state.inputs[typed.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      // A responder's `cancelled` declines the call: the approval is denied, not withdrawn.
      const outcome = typed.data.outcome === "approved" ? "approved" : "denied";
      const next = {
        ...state,
        inputs: {
          ...state.inputs,
          [typed.data.requestId]: { ...current, status: "settled", outcome },
        },
      } as S;
      return settleApprovalCall(next, current, outcome);
    }
    case "input.resolved": {
      let next: S = state;
      for (const resolution of typed.data.resolutions) {
        const current = next.inputs[resolution.requestId];
        if (current === undefined || current.status === "settled") continue;
        const response = resolution.response ?? current.response;
        const settled: Mutable<SessionInput> = {
          ...current,
          status: "settled",
          outcome: resolution.outcome,
        };
        if (response !== undefined) settled.response = response;
        next = { ...next, inputs: { ...next.inputs, [resolution.requestId]: settled } };
        next = settleApprovalCall(next, current, resolution.outcome);
      }
      return next;
    }
    case "authorization.required": {
      const attemptId = signInAttemptId(typed.data);
      const authorization: Mutable<SessionAuthorization> = {
        attemptId,
        name: typed.data.name,
        sequence: typed.data.sequence,
        turnId: typed.data.turnId,
        stepIndex: typed.data.stepIndex,
        status: "required",
      };
      if (typed.data.taskId !== undefined) authorization.taskId = typed.data.taskId;
      if (typed.data.principalId !== undefined) authorization.principalId = typed.data.principalId;
      if (typed.data.candidateId !== undefined) authorization.candidateId = typed.data.candidateId;
      if (typed.data.webhookUrl !== undefined) authorization.awaitsCallback = true;
      return { ...state, authorizations: { ...state.authorizations, [attemptId]: authorization } };
    }
    case "authorization.completed": {
      const attemptId = signInAttemptId(typed.data);
      const current = state.authorizations[attemptId];
      const completed: SessionAuthorization = {
        ...(current ?? {
          attemptId,
          name: typed.data.name,
          sequence: typed.data.sequence,
          turnId: typed.data.turnId,
          stepIndex: typed.data.stepIndex,
        }),
        status: typed.data.outcome,
      };
      return { ...state, authorizations: { ...state.authorizations, [attemptId]: completed } };
    }
    default:
      return state;
  }
}

/** A sign-in's attempt, or its connection name from a writer that sent no attempt. */
function signInAttemptId(data: { readonly attemptId?: string; readonly name: string }): string {
  return data.attemptId ?? data.name;
}

function isRelayed(request: { readonly callId?: string; readonly taskId?: string }): boolean {
  return request.callId !== undefined || request.taskId !== undefined;
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

/** Inputs awaiting an answer, including requests introduced in earlier turns. */
export function openInputs(state: SessionProjection): readonly SessionInput[] {
  return Object.values(state.inputs).filter((input) => input.status !== "settled");
}

/** Sign-ins the session still waits on. */
export function openSignIns(state: SessionProjection): readonly SessionAuthorization[] {
  return Object.values(state.authorizations).filter((attempt) => attempt.status === "required");
}

/**
 * Folds a read of a session's events. `observe` sees each event with the projection as it stood
 * before the event, for what a reader shows that the projection doesn't keep.
 */
export async function foldSessionEvents<E extends UnstampedMessageStreamEvent>(
  events: AsyncIterable<E>,
  observe?: (event: E, before: SessionProjection) => void,
): Promise<{
  readonly projection: SessionProjection;
  /** The prompt of each sign-in still open, in the order they were required. */
  readonly signIns: readonly AuthorizationRequiredStreamEvent["data"][];
}> {
  let projection = initialSessionProjection();
  const prompts = new Map<string, AuthorizationRequiredStreamEvent["data"]>();
  for await (const event of events) {
    observe?.(event, projection);
    projection = foldSession(projection, event);
    if (event.type === "authorization.required")
      prompts.set(signInAttemptId(event.data), event.data);
  }
  const signIns = openSignIns(projection).flatMap(
    (attempt) => prompts.get(attempt.attemptId) ?? [],
  );
  return { projection, signIns };
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
  const candidates = Object.fromEntries(
    Object.entries(state.candidates).filter(([, candidate]) => candidate.requestId in inputs),
  );
  return { ...state, authorizations, calls, candidates, inputs, tasks, turns };
}
