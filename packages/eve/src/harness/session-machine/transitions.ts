import type { ModelMessage, ToolCallPart, UserContent } from "ai";

import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import {
  type TurnWaitingOn,
  createActionResultEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createContextClearedEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createMessageReceivedEvent,
  createResultCompletedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepFailedEvent,
  createStepStartedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCancelledEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  createTurnWaitingEvent,
  type InputResolution,
  type RuntimeIdentity,
  type RuntimeTraceContext,
  type TaskCancelReason,
  type TaskStartedStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  openInputs,
  openSignIns,
  turnCoordinates,
  type SessionInput,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { Transition } from "./commit.js";
import { inputWithdrawn, signInWithdrawn } from "./events.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";
import { toProxyInputRequestEntries, type WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { StepCoordinates, SuspendedStep, TurnState } from "./state.js";
import {
  activeTurnId,
  answeredCallIds,
  nextStepIndex,
  runningTasks,
  turnPosition,
  type SessionView,
} from "./view.js";

// The session's lifecycle. Every transition reads a `SessionView` and returns the events that
// report what changed with the execution state that follows; `applyTransition` publishes and
// saves them, and nothing else builds a lifecycle event or writes `TurnState`. Approvals,
// the session-limit prompt, and sign-ins are in `approvals.ts`.
//
// Transitions are pure: what they need from effects (model responses, tool results, the
// requests a session relays) arrives in their input.

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

const unchanged = (view: SessionView, events: readonly UnstampedMessageStreamEvent[]) => ({
  events,
  turn: view.turn,
});

/** The coordinates the next lifecycle event carries. */
function at(projection: SessionProjection) {
  const position = turnPosition(projection);
  return {
    sequence: position.sequence,
    stepIndex: position.stepIndex,
    turnId: activeTurnId(position),
  };
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * Input arrives: the session starts once, a turn opens unless one is open (steering joins it),
 * and a message is received.
 */
export function receive(
  view: SessionView,
  input: {
    readonly message?: string | UserContent;
    readonly runtime?: RuntimeIdentity;
    readonly trace?: RuntimeTraceContext;
  },
): Transition {
  const position = turnPosition(view.projection);
  const turnId = activeTurnId(position);
  const events: UnstampedMessageStreamEvent[] = [];
  if (!position.sessionStarted) {
    events.push(createSessionStartedEvent({ runtime: input.runtime, trace: input.trace }));
  }
  if (position.turnId === "") {
    events.push(
      createTurnStartedEvent({
        sequence: position.sequence,
        trace: input.trace,
        turnId,
      }),
    );
  }
  if (input.message !== undefined) {
    events.push(
      createMessageReceivedEvent({ message: input.message, sequence: position.sequence, turnId }),
    );
  }
  return unchanged(view, events);
}

/** The open turn calls the model. */
export function startStep(view: SessionView, input: { readonly modelId: string }): Transition {
  const { sequence, turnId } = at(view.projection);
  return unchanged(view, [
    createStepStartedEvent({
      modelId: input.modelId,
      sequence,
      stepIndex: nextStepIndex(view.projection),
      turnId,
    }),
  ]);
}

/**
 * The open turn parks: on `"tasks"` while work it started runs, on `"input"` while a person must
 * act on a sign-in, approval, or question. It resumes in the same turn.
 */
export function hold(view: SessionView, input: { readonly on: TurnWaitingOn }): Transition {
  const { sequence, turnId } = turnPosition(view.projection);
  if (turnId === "") return unchanged(view, []);
  return unchanged(view, [
    createTurnWaitingEvent({ on: input.on, sequence, turnId, usage: view.usage }),
  ]);
}

/** Nothing is left to run: the turn completes, with its structured result when it has one. */
export function finishTurn(
  view: SessionView,
  input: { readonly result?: JsonValue } = {},
): Transition {
  const { sequence, stepIndex, turnId } = at(view.projection);
  const events: UnstampedMessageStreamEvent[] = [];
  if (input.result !== undefined) {
    events.push(createResultCompletedEvent({ result: input.result, sequence, stepIndex, turnId }));
  }
  if (view.projection.activeTurnId !== undefined) {
    events.push(createTurnCompletedEvent({ sequence, turnId }));
  }
  events.push(createSessionWaitingEvent(view.usage));
  return unchanged(view, events);
}

/**
 * The step failed. A recoverable failure parks the session for the user to retry; a terminal
 * one ends it.
 */
export function fail(
  view: SessionView,
  failure: {
    readonly code: string;
    readonly details?: JsonObject;
    readonly message: string;
    readonly terminal?: { readonly sessionId: string };
  },
): Transition {
  const { sequence, stepIndex, turnId } = at(view.projection);
  // The calls the turn approved but hadn't run never run: the model reads that they stopped.
  const stopped = view.turn.suspended.filter((step) => (step.approved?.length ?? 0) > 0);
  return {
    commit: stopped.flatMap(cancelledTranscript),
    events: failedEvents(view, failure, { sequence, stepIndex, turnId }),
    turn: {
      ...view.turn,
      suspended: view.turn.suspended.filter((step) => !stopped.includes(step)),
    },
  };
}

function failedEvents(
  view: SessionView,
  failure: Parameters<typeof fail>[1],
  at: StepCoordinates,
): UnstampedMessageStreamEvent[] {
  const { sequence, stepIndex, turnId } = at;
  const { code, details, message } = failure;
  return [
    createStepFailedEvent({ code, details, message, sequence, stepIndex, turnId }),
    createTurnFailedEvent({ code, details, message, sequence, turnId }),
    failure.terminal === undefined
      ? createSessionWaitingEvent(view.usage)
      : createSessionFailedEvent({
          code,
          details,
          message,
          sessionId: failure.terminal.sessionId,
          usage: view.usage,
        }),
  ];
}

/** The session waits for its next delivery. */
export function idle(view: SessionView): Transition {
  return unchanged(view, [createSessionWaitingEvent(view.usage)]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function sessionCompleted(
  usage: TokenUsage | undefined,
): ReturnType<typeof createSessionCompletedEvent> {
  return createSessionCompletedEvent(usage);
}

export function sessionFailed(input: {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
  readonly sessionId: string;
  readonly usage: TokenUsage | undefined;
}): ReturnType<typeof createSessionFailedEvent> {
  return createSessionFailedEvent(input);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** One call's result, ready for its step's transcript. */
export interface SettledCall {
  readonly part: ToolResultPart;
  /** A runtime result, reported at the coordinates of the step that made the call. */
  readonly result?: RuntimeActionResult;
}

/**
 * Results reach the steps that made their calls. A step whose every call now has a result
 * commits to history, where the model reads it.
 */
export function settle(view: SessionView, input: { readonly results: readonly SettledCall[] }) {
  const events: UnstampedMessageStreamEvent[] = [];
  const steps = [...view.turn.suspended];
  for (const { part, result } of input.results) {
    const index = steps.findIndex((step) => stepCallIds(step).has(part.toolCallId));
    const step = steps[index];
    if (step === undefined) continue;
    steps[index] = withoutApproved(
      { ...step, messages: withResult(step.messages, part) },
      new Set([part.toolCallId]),
    );
    if (result !== undefined) {
      events.push(createActionResultEvent({ result, ...step.event }));
    }
  }
  // A step that parked approvals beside its tasks asks for them once the tasks finish.
  for (const step of steps) {
    if (step.tasks.length === 0 || step.requests.length === 0) continue;
    if (runningTasks(step).length > 0) continue;
    if (step.requests.some((request) => request.requestId in view.projection.inputs)) continue;
    events.push(createInputRequestedEvent({ requests: step.requests, ...step.event }));
  }
  const complete = steps.filter(isComplete);
  return {
    commit: complete.flatMap((step) => step.messages),
    events,
    turn: { ...view.turn, suspended: steps.filter((step) => !complete.includes(step)) },
  } satisfies Transition;
}

/** A call a discarded model-call attempt announced without a result. */
export interface DiscardedCall {
  readonly callId: string;
  readonly toolName: string;
}

/** What a discarded attempt's calls report: the replacement attempt re-requests what it needs. */
const RETRIED_CALL_RESULT = {
  code: "MODEL_CALL_ATTEMPT_RETRIED",
  message: "The model call attempt was retried before this tool could run.",
} as const;

/**
 * A model-call attempt failed and the step retries it. The calls the attempt announced never
 * ran, so each settles as failed before the replacement attempt streams. Nothing reaches
 * history: the discarded response was never committed.
 */
export function discardAttempt(
  view: SessionView,
  input: { readonly calls: readonly DiscardedCall[] },
): Transition {
  const coordinates = at(view.projection);
  return unchanged(
    view,
    input.calls.map(({ callId, toolName }) =>
      createActionResultEvent({
        ...coordinates,
        result: {
          callId,
          isError: true,
          kind: "tool-result",
          output: { ...RETRIED_CALL_RESULT },
          toolName,
        },
      }),
    ),
  );
}

/**
 * A model response made calls the runtime runs. The response waits in a suspended step until
 * every call it made has a result, so a call never reaches the model without its result.
 */
export function suspendStep(
  view: SessionView,
  step: Pick<SuspendedStep, "event" | "messages" | "tasks">,
): Transition {
  return { events: [], turn: suspend(view.turn, { ...step, requests: [] }) };
}

/** The step without the approved calls in `callIds`, which have run or joined the runtime. */
export function withoutApproved(step: SuspendedStep, callIds: ReadonlySet<string>): SuspendedStep {
  if (step.approved === undefined) return step;
  const approved = step.approved.filter((request) => !callIds.has(request.action.callId));
  if (approved.length === step.approved.length) return step;
  const { approved: _approved, ...rest } = step;
  return approved.length === 0 ? rest : { ...rest, approved };
}

/** Approved calls of suspended steps that haven't run. */
export function approvedCalls(turn: TurnState): readonly InputRequest[] {
  return turn.suspended.flatMap((step) => step.approved ?? []);
}

export function suspend(turn: TurnState, step: SuspendedStep): TurnState {
  return { ...turn, suspended: [...turn.suspended, step] };
}

/** The ids of the calls a step's response made, except provider-executed ones. */
export function stepCallIds(step: Pick<SuspendedStep, "messages">): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of step.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.providerExecuted !== true) ids.add(part.toolCallId);
    }
  }
  return ids;
}

function isComplete(step: SuspendedStep): boolean {
  if (step.requests.length > 0) return false;
  const answered = answeredCallIds(step.messages);
  return [...stepCallIds(step)].every((callId) => answered.has(callId));
}

/**
 * Places a result right after the message that made its call, under the call's name: a call
 * made through `eve__tool` or `eve__skill` keeps that name in history, whatever entry it ran.
 */
export function withResult(
  messages: readonly ModelMessage[],
  result: ToolResultPart,
): ModelMessage[] {
  const next = [...messages];
  const asking = findCall(next, result.toolCallId);
  if (asking === undefined) {
    next.push({ content: [result], role: "tool" });
    return next;
  }
  const part = { ...result, toolName: asking.call.toolName };
  const following = next[asking.index + 1];
  if (following?.role === "tool") {
    next[asking.index + 1] = { ...following, content: [...following.content, part] };
  } else {
    next.splice(asking.index + 1, 0, { content: [part], role: "tool" });
  }
  return next;
}

/** The call with this id, and the index of the message that made it. */
function findCall(
  messages: readonly ModelMessage[],
  callId: string,
): { readonly call: ToolCallPart; readonly index: number } | undefined {
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    const call = message.content.find(
      (content): content is ToolCallPart =>
        content.type === "tool-call" && content.toolCallId === callId,
    );
    if (call !== undefined) return { call, index };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** A call started or reached a task. */
export function startTask(view: SessionView, task: TaskStartedStreamEvent["data"]): Transition {
  return unchanged(view, [createTaskStartedEvent(task)]);
}

export type TaskCallOutcome =
  | { readonly status: "completed"; readonly output?: JsonValue }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason?: TaskCancelReason };

/** A task's run settled calls: each reports its outcome, naming the task as it started. */
export function settleTask(
  view: SessionView,
  input: {
    readonly task: {
      readonly id: string;
      readonly kind?: TaskStartedStreamEvent["data"]["kind"];
      readonly name?: string;
    };
    readonly calls: readonly { readonly callId: string; readonly turnId: string }[];
    readonly outcome: TaskCallOutcome;
  },
): Transition {
  const { outcome, task } = input;
  return unchanged(
    view,
    input.calls.map((call) => {
      const base = {
        callId: call.callId,
        kind: task.kind,
        name: task.name,
        taskId: task.id,
        turnId: call.turnId,
      };
      switch (outcome.status) {
        case "completed":
          return createTaskSettledEvent({ ...base, output: outcome.output, status: "completed" });
        case "failed":
          return createTaskSettledEvent({
            ...base,
            error: { message: outcome.error },
            status: "failed",
          });
        case "cancelled":
          return createTaskSettledEvent(
            outcome.reason === undefined
              ? { ...base, status: "cancelled" }
              : { ...base, cancel: { reason: outcome.reason }, status: "cancelled" },
          );
      }
    }),
  );
}

/**
 * A task or workflow run ended, on its own or cancelled: nobody can answer what it relayed, so
 * each request still open is withdrawn.
 */
export function finishRun(
  view: SessionView,
  run: { readonly taskId?: string; readonly requestIds?: Iterable<string> },
): Transition {
  const ids = new Set(run.requestIds);
  return unchanged(
    view,
    openInputs(view.projection)
      .filter(
        (input) =>
          ids.has(input.request.requestId) ||
          (run.taskId !== undefined && input.taskId === run.taskId),
      )
      .map(inputWithdrawn),
  );
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * A child session or workflow run asks a question or for a sign-in. The session passes it up
 * with its original coordinates, and the open turn waits on the call it serves.
 * A child's fresh batch replaces its earlier one, whose open requests are withdrawn.
 */
export function relay(
  view: SessionView,
  input: {
    readonly payload: SubagentInputRequestHookPayload | SubagentAuthorizationEventHookPayload;
    readonly replacedRequestIds?: Iterable<string>;
    /** The workflow tool run that relays the request, and the hook its `ctx.ask()` answers reach. */
    readonly runId?: string;
    readonly workflowAsk?: WorkflowAskRoute;
  },
): Transition {
  const { payload } = input;
  const events: UnstampedMessageStreamEvent[] = [
    ...finishRun(view, { requestIds: input.replacedRequestIds }).events,
  ];
  if (payload.kind === "subagent-input-request") {
    const { event } = payload;
    events.push(
      createInputRequestedEvent({
        callId: payload.callId,
        requests: event.requests,
        sequence: event.sequence,
        stepIndex: event.stepIndex,
        taskId: event.taskId,
        turnId: event.turnId,
      }),
    );
  } else {
    const { event } = payload;
    events.push(event);
    if (event.type !== "authorization.required") return unchanged(view, events);
  }
  events.push(...hold(view, { on: "input" }).events);
  if (payload.kind !== "subagent-input-request") return unchanged(view, events);
  // A child's fresh batch replaces the routes its prior one held.
  const entries = toProxyInputRequestEntries(payload).map(
    ([requestId, route]) =>
      [
        requestId,
        {
          ...route,
          ...(input.workflowAsk !== undefined && { workflowAsk: input.workflowAsk }),
          ...(input.runId !== undefined && { runId: input.runId }),
        },
      ] as const,
  );
  return {
    ...unchanged(view, events),
    relays: {
      upsert: {
        entries,
        forChildContinuationToken: payload.childContinuationToken,
        inputSource: payload.inputSource,
      },
    },
  };
}

/**
 * Answers to relayed requests are on their way to the asker: each request resolves here.
 */
export function receiveRelayedAnswer(input: {
  readonly message: string | UserContent;
  readonly sequence: number;
  readonly turnId: string;
}) {
  return createMessageReceivedEvent(input);
}

export function routeAnswer(
  view: SessionView,
  input: {
    readonly children: readonly {
      readonly event: StepCoordinates;
      readonly resolutions: readonly InputResolution[];
    }[];
    /**
     * Answers left other relayed requests pending, and nothing for the turn itself: the open
     * turn stays held, as after a partial approval answer.
     */
    readonly holds?: boolean;
  },
): Transition {
  const events: UnstampedMessageStreamEvent[] = input.children
    .filter((child) => child.resolutions.length > 0)
    .map((child) => createInputResolvedEvent({ resolutions: child.resolutions, ...child.event }));
  if (input.holds === true) events.push(...hold(view, { on: "input" }).events);
  // The answered routes retire, so a later delivery can't route through them.
  const retire = input.children.flatMap((child) => child.resolutions.map((r) => r.requestId));
  return { ...unchanged(view, events), ...(retire.length > 0 && { relays: { retire } }) };
}

/**
 * A workflow run's sign-in, reported to the session that owns the run, which relays it. Built
 * where the run asks, at the coordinates of the call it serves.
 */
export function runSignIn(
  from: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly taskId?: string;
    readonly turnId: string;
  },
  challenge: AuthorizationChallenge,
  outcome?: "authorized" | "failed",
) {
  const fields = {
    ...authorizationEventFields(challenge),
    sequence: from.sequence,
    stepIndex: from.stepIndex,
    taskId: from.taskId,
    turnId: from.turnId,
  };
  return outcome === undefined
    ? createAuthorizationRequiredEvent({
        ...fields,
        description: `Sign in to ${challenge.name} to continue.`,
        webhookUrl: challenge.hookUrl,
      })
    : createAuthorizationCompletedEvent({ ...fields, outcome });
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

/**
 * Sign-in callbacks matched the attempts `attemptIds` name: the session stops waiting on them.
 * Their completions report once the turn they resume runs (`completeSignIn`).
 */
export function matchSignIns(
  view: SessionView,
  input: { readonly attemptIds: readonly string[] },
): Transition {
  const matched = new Set(input.attemptIds);
  return {
    ...unchanged(view, []),
    signIns: view.signIns.filter((challenge) => !matched.has(signInAttemptKey(challenge))),
  };
}

/** Sign-in callbacks arrived: each completion is reported at the coordinates of the turn that asked. */
export function completeSignIn(
  view: SessionView,
  input: { readonly completions: readonly AuthorizationChallenge[] },
): Transition {
  const position = at(view.projection);
  return unchanged(
    view,
    input.completions.map((challenge) => {
      const attempt =
        challenge.attemptId === undefined
          ? undefined
          : view.projection.authorizations[challenge.attemptId];
      return createAuthorizationCompletedEvent({
        ...authorizationEventFields(challenge),
        outcome: "authorized",
        sequence: attempt?.sequence ?? position.sequence,
        stepIndex: attempt?.stepIndex ?? position.stepIndex,
        turnId: attempt?.turnId ?? position.turnId,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Cancel and clear
// ---------------------------------------------------------------------------

/** Requests this session asked itself and still awaits; relayed requests answer elsewhere. */
export function ownOpenRequestIds(view: Omit<SessionView, "turn">): ReadonlySet<string> {
  return new Set(
    openInputs(view.projection)
      .filter(
        (input) =>
          input.callId === undefined &&
          input.taskId === undefined &&
          !view.relayedRequestIds.has(input.request.requestId),
      )
      .map((input) => input.request.requestId),
  );
}

/** What the model reads for a call its turn's cancellation stopped before the call settled. */
export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

/**
 * `session.cancel()`: the open turn ends cancelled. Its requests, its sign-ins, and every
 * relayed request are withdrawn, since the cancel stops the work that asked them; its unsettled
 * calls are stopped. The steps it ran commit to history, each unfinished call answered as
 * cancelled, so the model sees that the work started and stopped.
 */
export function cancel(view: SessionView): Transition {
  const { projection } = view;
  const turnId = projection.activeTurnId;
  const stopped = view.turn.suspended.filter(
    (step) =>
      (turnId !== undefined && step.event.turnId === turnId) ||
      step.tasks.some((task) => !answeredCallIds(step.messages).has(task.callId)) ||
      (step.approved?.length ?? 0) > 0,
  );
  const stoppedRequestIds = new Set(
    stopped.flatMap((step) => step.requests.map((request) => request.requestId)),
  );
  const owned = (input: SessionInput) =>
    input.turnId === turnId ||
    stoppedRequestIds.has(input.request.requestId) ||
    view.relayedRequestIds.has(input.request.requestId) ||
    input.request.kind === "session-limit";
  const events: UnstampedMessageStreamEvent[] = [
    ...openInputs(projection).filter(owned).map(inputWithdrawn),
    ...openSignIns(projection)
      .filter((attempt) => attempt.turnId === turnId)
      .map((attempt) => signInWithdrawn(attempt, "Cancelled.")),
  ];
  if (turnId !== undefined) {
    const { sequence } = turnCoordinates(projection);
    events.push(createTurnCancelledEvent({ sequence, turnId }));
  }
  events.push(createSessionWaitingEvent(view.usage));
  return {
    commit: stopped.flatMap(cancelledTranscript),
    events,
    // Every sign-in the turn held ends with it.
    signIns: [],
    turn: {
      ...view.turn,
      suspended: view.turn.suspended.filter((step) => !stopped.includes(step)),
    },
  };
}

/** A stopped step's response, each call without a result answered as cancelled. */
function cancelledTranscript(step: SuspendedStep): ModelMessage[] {
  const answered = answeredCallIds(step.messages);
  let messages = [...step.messages];
  for (const message of step.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) continue;
      if (answered.has(part.toolCallId)) continue;
      messages = withResult(messages, {
        output: { type: "text", value: CANCELLED_CALL_RESULT },
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-result",
      });
    }
  }
  return messages;
}

/**
 * `session.clear()`: everything the cleared history asked for is withdrawn, its approvals and
 * the session-limit prompt and every sign-in, and the calls awaiting them stop. Requests relayed
 * from live tasks stay: clearing doesn't stop the work that asked them.
 */
export function clear(view: SessionView, input: { readonly sessionId: string }): Transition {
  const { projection } = view;
  const { sequence, turnId } = turnCoordinates(projection);
  return {
    clearsHistory: true,
    events: [
      ...openInputs(projection)
        .filter((open) => !view.relayedRequestIds.has(open.request.requestId))
        .map(inputWithdrawn),
      ...openSignIns(projection).map((attempt) =>
        signInWithdrawn(attempt, "The context was cleared."),
      ),
      createContextClearedEvent({ sequence, sessionId: input.sessionId, turnId }),
      createSessionWaitingEvent(view.usage),
    ],
    turn: { grants: view.turn.grants, suspended: [] } satisfies TurnState,
  };
}
