import type {
  ActionResultError,
  ApprovalCandidateOutcome,
  AuthorizationOutcome,
  InputResolutionOutcome,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";

// The one fold from a session's stream events to its lifecycle: turns, requests, calls, tasks,
// and sign-ins. The server stores it with each step, clients carry it in `ConversationState`,
// and evals and ACP fold a run's events through it. It reads only the public protocol, and
// workflow bodies import it, so it must stay free of runtime dependencies.

export interface SessionTurn {
  readonly turnId: string;
  readonly sequence: number;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  /** The open turn is parked, holding on its tasks or on a person: a sign-in, approval, or question. */
  readonly waiting?: boolean;
  /** The step the turn's latest `step.started` opened, or `0` before its first. */
  readonly stepIndex: number;
  /** The turn published a `step.started`. */
  readonly stepStarted?: true;
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
export interface SessionTaskCall {
  readonly callId: string;
  readonly turnId: string;
  readonly status: "working" | "completed" | "failed" | "cancelled";
  /** The call's result; present only when `status` is `"completed"`. */
  readonly output?: JsonValue;
  /** Why the call failed; present only when `status` is `"failed"`. */
  readonly error?: { readonly message: string };
}

export interface SessionTask {
  readonly taskId: string;
  /** The tool whose call started the task. */
  readonly name: string;
  /**
   * `"agent"` when a subagent's tool, local or remote, started the task; `"tool"` for an authored
   * tool, including one that opens sessions with `ctx.agent`.
   */
  readonly kind: "agent" | "tool";
  /** Calls in the order they started or reached the task. */
  readonly calls: Readonly<Record<string, SessionTaskCall>>;
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

export interface SessionCall {
  readonly callId: string;
  /** The tool, subagent, or skill the call invokes. */
  readonly name: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly status: SessionCallStatus;
  /** The approval request the call awaits, or awaited. */
  readonly requestId?: string;
  /** The task the call started or reached. */
  readonly taskId?: string;
  readonly error?: ActionResultError;
}

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
  /** The calls the sign-in stopped; they run once it completes. */
  readonly callIds?: readonly string[];
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
  /** The sequence the next turn takes. */
  readonly nextSequence: number;
  readonly turns: Readonly<Record<string, SessionTurn>>;
  /** By `requestId`. */
  readonly inputs: Readonly<Record<string, SessionInput>>;
  /** By `taskId`. */
  readonly tasks: Readonly<Record<string, SessionTask>>;
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

function updateTask<S extends SessionProjection>(
  state: S,
  taskId: string,
  update: (task: SessionTask) => SessionTask,
): S {
  const task = state.tasks[taskId];
  if (task === undefined) return state;
  const next = update(task);
  return next === task ? state : { ...state, tasks: { ...state.tasks, [taskId]: next } };
}

function updateCall<S extends SessionProjection>(
  state: S,
  callId: string,
  update: (call: SessionCall) => SessionCall,
): S {
  const call = state.calls[callId];
  if (call === undefined) return state;
  const next = update(call);
  return next === call ? state : { ...state, calls: { ...state.calls, [callId]: next } };
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
  if (isSettledCallStatus(call.status)) return call;
  const { requestId: _requestId, error: _error, ...rest } = call;
  const settled: Mutable<SessionCall> = { ...rest, status };
  if (call.requestId !== undefined) settled.requestId = call.requestId;
  if (error !== undefined) settled.error = error;
  return settled;
}

function actionName(action: RuntimeActionRequest): string {
  switch (action.kind) {
    case "load-skill":
      return "load_skill";
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
      return "load_skill";
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
      const turn: SessionTurn = { turnId, sequence, status: "active", stepIndex: 0 };
      return {
        ...state,
        activeTurnId: turnId,
        nextSequence: Math.max(state.nextSequence, sequence + 1),
        turns: {
          ...state.turns,
          [turnId]: turn,
        },
      };
    }
    case "step.started":
      return updateTurn(state, typed.data.turnId, (turn) => {
        if (!turn.waiting && turn.stepStarted && turn.stepIndex === typed.data.stepIndex) {
          return turn;
        }
        const { waiting: _waiting, ...rest } = turn;
        return { ...rest, stepIndex: typed.data.stepIndex, stepStarted: true };
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
      const { waiting: _waiting, ...rest } = turn ?? {
        turnId,
        sequence: typed.data.sequence,
        stepIndex: 0,
      };
      return {
        ...state,
        activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
        turns: { ...state.turns, [turnId]: { ...rest, status } },
      };
    }
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
          : status === "cancelled"
            ? "cancelled"
            : status === "failed" || result.isError === true
              ? "failed"
              : "completed";
      if (call === undefined) {
        // A result whose call wasn't announced, such as an approved call resuming.
        const unannounced: Mutable<SessionCall> = {
          callId: result.callId,
          name: resultName(result),
          turnId: typed.data.turnId,
          stepIndex: typed.data.stepIndex,
          status: settled,
        };
        if (error !== undefined) unannounced.error = error;
        return { ...state, calls: { ...state.calls, [result.callId]: unannounced } };
      }
      return updateCall(state, result.callId, (current) => settleCall(current, settled, error));
    }
    case "task.started": {
      const { callId, kind, name, taskId, turnId } = typed.data;
      const task = state.tasks[taskId] ?? { taskId, name, kind, calls: {} };
      let next: S = state;
      if (task.calls[callId] === undefined) {
        next = {
          ...next,
          tasks: {
            ...next.tasks,
            [taskId]: {
              ...task,
              calls: { ...task.calls, [callId]: { callId, turnId, status: "working" } },
            },
          },
        };
      }
      const call = next.calls[callId];
      const running: SessionCall = {
        ...(call ?? { callId, name, turnId, stepIndex: 0 }),
        status: "running",
        taskId,
      };
      const { error: _error, ...withoutError } = running;
      return { ...next, calls: { ...next.calls, [callId]: withoutError } };
    }
    case "task.settled": {
      const { callId, error, output, status, taskId } = typed.data;
      const next = updateTask(state, taskId, (task) => {
        const call = task.calls[callId];
        if (call === undefined || call.status !== "working") return task;
        const settled = { callId, turnId: call.turnId, status };
        return {
          ...task,
          calls: {
            ...task.calls,
            [callId]:
              status === "completed" && output !== undefined
                ? { ...settled, output }
                : status === "failed" && error !== undefined
                  ? { ...settled, error }
                  : settled,
          },
        };
      });
      return updateCall(next, callId, (call) =>
        call.taskId === taskId && call.status === "running"
          ? settleCall(
              call,
              status,
              error === undefined ? undefined : { code: "TASK_FAILED", message: error.message },
            )
          : call,
      );
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
      const attemptId = typed.data.attemptId ?? typed.data.name;
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
      if ((typed.data.callIds?.length ?? 0) > 0) authorization.callIds = typed.data.callIds;
      if (typed.data.webhookUrl !== undefined) authorization.awaitsCallback = true;
      return { ...state, authorizations: { ...state.authorizations, [attemptId]: authorization } };
    }
    case "authorization.completed": {
      const attemptId = typed.data.attemptId ?? typed.data.name;
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
    return { sequence: turn.sequence, stepIndex: turn.stepIndex, turnId: turn.turnId };
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

/** Task calls whose run hasn't settled them. */
export function workingTaskCalls(state: SessionProjection): readonly SessionTaskCall[] {
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
  if (call.status !== "running" || call.taskId !== undefined) return call.status;
  const turn = state.turns[call.turnId];
  if (options.streaming === false || (turn !== undefined && turn.status !== "active")) {
    return "interrupted";
  }
  return call.status;
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
        !isSettledCallStatus(call.status) ||
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
  const tasks: Record<string, SessionTask> = {};
  for (const [taskId, task] of Object.entries(state.tasks)) {
    const working = Object.entries(task.calls).filter(([, call]) => call.status === "working");
    if (working.length > 0) tasks[taskId] = { ...task, calls: Object.fromEntries(working) };
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
