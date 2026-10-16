import type { ModelMessage, ToolCallPart } from "ai";

import type { RelayedInteractionEvent, SubagentInteractionHookPayload } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { callSettledFrom } from "#harness/call-facts.js";
import { closeUnder } from "#harness/session-machine/cascade.js";
import { isOpen } from "#protocol/session-projection/tree.js";
import { activeTurn, interactionOwner } from "#protocol/session-projection/selectors.js";
import type {
  RuntimeIdentity,
  TraceContext,
  SessionPredecessor,
  TaskCancelReason,
} from "#protocol/message.js";
import {
  interactionSettled,
  responseSettled,
  responseAdmitted,
  responseSubmitted,
  signInInteractionId,
  signInOpened,
} from "#harness/interaction-facts.js";
import type {
  DeliveryAdmittedData,
  DeliverySource,
} from "#protocol/session-events/families/delivery.js";
import type { ControlDelivery } from "#harness/types.js";
import type { ResponseSubmittedData } from "#protocol/session-events/families/response.js";
import type { ModelOwner } from "#protocol/session-events/families/model.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type {
  Cause,
  ErrorInfo,
  Principal,
  Usage,
  UserPart,
} from "#protocol/session-events/envelope.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import {
  activeTurnIdOf,
  nextChangeId,
  nextRunId,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { SessionView as PublicView } from "#protocol/session-projection/tables.js";
import { openRequests } from "#protocol/session-reader.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { Answer } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { Transition } from "./commit.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";
import type { Relay, WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { SuspendedStep, TurnState } from "./state.js";
import { activeTurnId, answeredCallIds, turnPosition, type SessionView } from "./view.js";

// The session's lifecycle. Every transition reads a `SessionView` and returns the facts that
// report what changed with the execution state that follows; `applyTransition` publishes them as
// one commit and saves the rest, and nothing else builds a lifecycle fact or writes `TurnState`.
// Approvals, the session-limit prompt, and sign-ins are in `approvals.ts`.
//
// When the machine ends something, the same commit ends everything that ends with it: a turn's
// open runs and calls, and the deliveries it answered. Nothing is left for readers to infer.
//
// Transitions are pure: what they need from effects (model responses, tool results, the
// requests a session relays) arrives in their input.

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

const unchanged = (view: SessionView, events: readonly SessionEvent[]) => ({
  events,
  turn: view.turn,
});

/** The coordinates the v26 work events still carry. */
function at(projection: SessionProjection) {
  const position = turnPosition(projection);
  return {
    sequence: position.sequence,
    stepIndex: position.stepIndex,
    turnId: activeTurnId(position),
  };
}

/** A delivery a turn consumes, with what the person sent: nothing for an answer or context. */
export interface ConsumedDelivery {
  readonly deliveryId: string;
  readonly parts: readonly UserPart[];
}

/** The turn the next turn follows: the newest, unless a context change chose another or none. */
function followedTurn(projection: SessionProjection): string | null {
  const selection = projection.view.selection;
  if (selection === null) return null;
  return selection?.turnId ?? projection.view.session.latestTurnId ?? null;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/** The deliveries the session admitted and nothing has consumed or settled yet. */
function waitingDeliveries(
  projection: SessionProjection,
  deliveries: readonly ConsumedDelivery[],
): readonly ConsumedDelivery[] {
  return deliveries.filter(
    ({ deliveryId }) => projection.view?.deliveries[deliveryId]?.status === "admitted",
  );
}

/**
 * Deliveries arrive for a turn: the session starts once, a turn opens unless one is open, and
 * each delivery is consumed into it.
 */
export function receive(
  view: SessionView,
  input: {
    readonly deliveries?: readonly ConsumedDelivery[];
    /** What starts the turn when no delivery does. */
    readonly cause?: Cause;
    readonly parent?: { readonly sessionId: string; readonly callId: string };
    /** The session this one replaced, when eve started it in place of a stranded one. */
    readonly predecessor?: SessionPredecessor;
    readonly runtime?: RuntimeIdentity;
    readonly trace?: TraceContext;
  },
): Transition {
  const { projection } = view;
  const position = turnPosition(projection);
  const turnId = activeTurnId(position);
  // Only a delivery still waiting is consumed. One that settled, such as an answer the turn
  // answered for now while it waited for the rest of its batch, or one a policy refused, is not.
  const deliveries = waitingDeliveries(projection, input.deliveries ?? []);
  const first = deliveries[0];
  const cause: Cause =
    first === undefined ? (input.cause ?? { policy: "system" }) : { deliveryId: first.deliveryId };
  const events: SessionEvent[] = [];
  if (!position.sessionStarted) {
    const data: {
      -readonly [
        K in keyof FactOf<"session.started">["data"]
      ]: FactOf<"session.started">["data"][K];
    } = {};
    if (input.parent !== undefined) data.parent = input.parent;
    if (input.predecessor !== undefined) data.predecessor = input.predecessor;
    if (input.runtime !== undefined) data.runtime = input.runtime;
    if (input.trace !== undefined) data.trace = input.trace;
    events.push({ data, type: "session.started" });
  }
  if (position.turnId === "") {
    const data: {
      -readonly [K in keyof FactOf<"turn.started">["data"]]: FactOf<"turn.started">["data"][K];
    } = {
      cause,
      follows: followedTurn(projection),
      turnId,
    };
    if (input.trace !== undefined) data.trace = input.trace;
    events.push({ data, type: "turn.started" });
  }
  for (const delivery of deliveries) {
    events.push({
      data: { deliveryId: delivery.deliveryId, parts: delivery.parts, turnId },
      type: "delivery.consumed",
    });
  }
  return unchanged(view, events);
}

/**
 * Deliveries join the open turn without opening one, as answers do.
 * Between turns an answer has nothing to join: it took effect, and settles `applied`. A delivery
 * already settled, such as one refused, joins nothing.
 */
export function join(
  view: SessionView,
  input: { readonly deliveries: readonly ConsumedDelivery[] },
): Transition {
  const { projection } = view;
  const open = waitingDeliveries(projection, input.deliveries);
  const turnId = activeTurnIdOf(projection);
  if (turnId === undefined) {
    return unchanged(
      view,
      open.map(({ deliveryId }) => ({
        data: { deliveryId, outcome: "applied" },
        type: "delivery.settled",
      })),
    );
  }
  const events: SessionEvent[] = [];
  for (const delivery of open) {
    events.push({
      data: { deliveryId: delivery.deliveryId, parts: delivery.parts, turnId },
      type: "delivery.consumed",
    });
  }
  return unchanged(view, events);
}

/** The open turn needs the model: a run is requested before its model and tools are chosen. */
export function requestModel(view: SessionView): Transition & { readonly runId: string } {
  const { turnId } = at(view.projection);
  const runId = nextRunId(view.projection);
  return { ...unchanged(view, [runRequested({ turnId }, runId)]), runId };
}

/** A model run is asked for: a turn's, or a context change's summary run. */
export function runRequested(owner: ModelOwner, runId: string): SessionEvent {
  return { data: { owner, runId }, type: "model.requested" };
}

/** The run's model was chosen and an attempt at its provider call begins. */
export function startModel(view: SessionView, input: RunStart): Transition {
  return unchanged(view, [runStarted(input)]);
}

interface RunStart {
  readonly runId: string;
  readonly modelId: string;
  readonly attempt: number;
}

export function runStarted(input: RunStart): SessionEvent {
  const { attempt, modelId, runId } = input;
  return { data: { attempt, modelId, runId }, type: "model.started" };
}

/** The run's attempt failed, and the run tries again. */
export function retryModel(
  view: SessionView,
  input: { readonly runId: string; readonly attempt: number; readonly error: ErrorInfo },
): Transition {
  return unchanged(view, [
    {
      data: { attempt: input.attempt, error: input.error, runId: input.runId },
      type: "model.retried",
    },
  ]);
}

/** How a run ended, and what it spent. */
export interface RunSettlement {
  readonly runId: string;
  readonly outcome: FactOf<"model.settled">["data"]["outcome"];
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
  readonly usage?: FactOf<"usage.recorded">["data"]["usage"];
}

/** A run settles, with its usage in the same commit. */
export function settleModel(view: SessionView, input: RunSettlement): Transition {
  return unchanged(view, runSettledFacts(input));
}

/** The facts that settle a run: its end, then what it spent. */
export function runSettledFacts(input: RunSettlement): SessionEvent[] {
  const data: {
    -readonly [K in keyof FactOf<"model.settled">["data"]]: FactOf<"model.settled">["data"][K];
  } = {
    outcome: input.outcome,
    runId: input.runId,
  };
  if (input.finishReason !== undefined) data.finishReason = input.finishReason;
  if (input.generationId !== undefined) data.generationId = input.generationId;
  if (input.error !== undefined) data.error = input.error;
  const facts: SessionEvent[] = [{ data, type: "model.settled" }];
  if (input.usage !== undefined) {
    facts.push({
      data: { kind: "model", owner: { runId: input.runId }, usage: input.usage },
      type: "usage.recorded",
    });
  }
  return facts;
}

/** How a turn ends. */
interface TurnEnding {
  readonly outcome: FactOf<"turn.settled">["data"]["outcome"];
  readonly cause?: Cause;
  readonly error?: ErrorInfo;
}

/**
 * The fact that ends the open turn. The writer closes what it leaves open before it, and settles
 * the deliveries it answered after it (`cascade`).
 */
function closeTurn(
  projection: SessionProjection,
  ending: TurnEnding,
  turnId = activeTurn(projection.view)?.turnId,
): SessionEvent[] {
  if (turnId === undefined) return [];
  const turn = projection.view.turns[turnId];
  const data: {
    -readonly [K in keyof FactOf<"turn.settled">["data"]]: FactOf<"turn.settled">["data"][K];
  } = {
    outcome: ending.outcome,
    turnId,
  };
  if (turn?.reply !== undefined && turn.reply.length > 0) data.reply = turn.reply;
  if (ending.cause !== undefined) data.cause = ending.cause;
  if (ending.error !== undefined) data.error = ending.error;
  return [{ data, type: "turn.settled" }];
}

/** Nothing is left to run: the turn completes. */
export function finishTurn(view: SessionView): Transition {
  return unchanged(view, closeTurn(view.projection, { outcome: "completed" }));
}

/** A failure as the stream reports it: its code and message, with its support id and remedy. */
export function errorInfoOf(failure: {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
}): ErrorInfo {
  const error: { -readonly [K in keyof ErrorInfo]: ErrorInfo[K] } = {
    code: failure.code,
    message: failure.message,
  };
  const { errorId, hint } = failure.details ?? {};
  if (typeof errorId === "string") error.id = errorId;
  if (typeof hint === "string" && hint.trim().length > 0) error.hint = hint.trim();
  return error;
}

/**
 * The step failed. A recoverable failure leaves the session for the user to retry; a terminal
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
  const error = errorInfoOf(failure);
  const turnId = activeTurnIdOf(view.projection);
  // A terminal failure ends the session, which ends the turn with it, in one commit.
  const events =
    failure.terminal === undefined
      ? closeTurn(view.projection, { error, outcome: "failed" })
      : sessionEndedFacts(view.projection, {
          cause: turnId === undefined ? undefined : { turnId },
          error,
          outcome: "failed",
        });
  return unchanged(view, events);
}

/** The session waits for its next delivery. Nothing is written: readers ask `idle`. */
export function idle(view: SessionView): Transition {
  return unchanged(view, []);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * The facts that end a session, in one commit, `session.ended` last. The writer closes what the
 * session leaves open before it (`cascade`): an open turn ends cancelled, since its session ended,
 * not it; `failure(view, turnId)` reads the session's error. Every reader stops there.
 */
export function sessionEndedFacts(
  projection: SessionProjection | undefined,
  ending: {
    readonly outcome: "completed" | "failed";
    readonly cause?: Cause;
    /** The reset control that ends the session: admitted first, applied before the end. */
    readonly control?: ControlDelivery;
    readonly error?: ErrorInfo;
  },
): SessionEvent[] {
  const facts: SessionEvent[] = [];
  // A session that ends before it started, as one that fails admitting its first message or a
  // prewarmed one that expires, starts in the same commit: only a started session ends.
  if (projection !== undefined && projection.view.session.status === "new") {
    facts.push({ data: {}, type: "session.started" });
  }
  const { control } = ending;
  if (control !== undefined) facts.push(controlAdmitted(control, "reset"));
  if (control !== undefined) facts.push(deliveryApplied(control.deliveryId));
  const data: {
    -readonly [K in keyof FactOf<"session.ended">["data"]]: FactOf<"session.ended">["data"][K];
  } = {
    outcome: ending.outcome,
  };
  const cause = control === undefined ? ending.cause : { deliveryId: control.deliveryId };
  if (cause !== undefined) data.cause = cause;
  if (ending.error !== undefined) data.error = ending.error;
  facts.push({ data, type: "session.ended" });
  return facts;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** One call's result, ready for its step's transcript. */
export interface SettledCall {
  readonly part: ToolResultPart;
  /** A runtime result, reported at the coordinates of the step that made the call. */
  readonly result?: RuntimeActionResult;
  /** What the agent behind the call spent, which its settlement records. */
  readonly usage?: TokenUsage;
}

/** What the agent behind a call spent, recorded against the call. */
export function delegatedUsageFact(callId: string, usage: TokenUsage): SessionEvent {
  const recorded: { -readonly [K in keyof Usage]: Usage[K] } = {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  if (usage.costUsd !== undefined) recorded.costUsd = usage.costUsd;
  return {
    data: { kind: "model", owner: { callId }, usage: recorded },
    type: "usage.recorded",
  };
}

/**
 * Results reach the steps that made their calls. A step whose every call now has a result
 * commits to history, where the model reads it.
 */
export function settle(view: SessionView, input: { readonly results: readonly SettledCall[] }) {
  const events: SessionEvent[] = [];
  const steps = [...view.turn.suspended];
  for (const { part, result, usage } of input.results) {
    const index = steps.findIndex((step) => stepCallIds(step).has(part.toolCallId));
    const step = steps[index];
    if (step === undefined) continue;
    steps[index] = { ...step, messages: withResult(step.messages, part) };
    const recorded = result === undefined ? undefined : view.projection.view.calls[result.callId];
    if (result !== undefined && recorded?.taskId === undefined && recorded?.status !== "settled") {
      // A task's start receipt is model history only. Its public call stays open until the
      // task replies; the reply path publishes its actual settlement and delegated spend.
      events.push(callSettledFrom(result));
      // A child's usage counts once, in the commit that settles its call.
      if (usage !== undefined) events.push(delegatedUsageFact(result.callId, usage));
    }
  }
  const complete = steps.filter(isComplete);
  return {
    commit: complete.flatMap((step) => step.messages),
    events,
    turn: { ...view.turn, suspended: steps.filter((step) => !complete.includes(step)) },
  } satisfies Transition;
}

/**
 * A model-call attempt ends without its response reaching history, in one commit with the calls
 * it announced. A retry replaces it: eve can't tell whether those calls ran, so they and the run
 * settle `abandoned`. Steering cut it off: the calls are interrupted, and the run completed what
 * it streamed, with what it spent.
 */
export function discardAttempt(
  view: SessionView,
  input: {
    readonly runId: string;
    readonly ending: "retried" | "steered";
    readonly usage?: FactOf<"usage.recorded">["data"]["usage"];
  },
): Transition {
  const tables = view.projection.view;
  const ref = { family: "run" as const, id: input.runId };
  // A retry abandons the run, and the writer abandons what it announced with it; steering
  // completes what it streamed, so its calls close here.
  const work = input.ending === "steered" ? closeUnder(tables, ref, "steered") : [];
  if (!isOpen(tables, ref)) return unchanged(view, work);
  const run =
    input.ending === "retried"
      ? { outcome: "abandoned" as const, runId: input.runId, usage: input.usage }
      : {
          finishReason: "other",
          outcome: "completed" as const,
          runId: input.runId,
          usage: input.usage,
        };
  return unchanged(view, [...work, ...runSettledFacts(run)]);
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

/** Every call the step made has a result: a pending approval's call has none yet. */
function isComplete(step: SuspendedStep): boolean {
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

/** Private dispatch metadata for a call that starts or reaches a task. */
export interface TaskCallStart {
  readonly callId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly kind: "agent" | "tool";
  readonly name: string;
}

/** A task starts once; every call it serves starts against that task. */
export function startTask(
  view: SessionView,
  task: TaskCallStart,
  introducedTasks?: Set<string>,
): Transition {
  const events: SessionEvent[] = [];
  const introduced =
    introducedTasks?.has(task.taskId) ?? view.projection.view.tasks[task.taskId] !== undefined;
  if (!introduced) {
    introducedTasks?.add(task.taskId);
    events.push({
      type: "task.started",
      data: {
        taskId: task.taskId,
        kind: task.kind,
        name: task.name,
        startedBy: { callId: task.callId },
      },
    });
  }
  events.push({ type: "call.started", data: { callId: task.callId, taskId: task.taskId } });
  return unchanged(view, events);
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
      readonly kind?: TaskCallStart["kind"];
      readonly name?: string;
    };
    readonly calls: readonly { readonly callId: string; readonly turnId: string }[];
    readonly outcome: TaskCallOutcome;
  },
): Transition {
  const { outcome } = input;
  const settled = input.calls.map((call, index): SessionEvent => {
    const data: {
      -readonly [K in keyof FactOf<"call.settled">["data"]]: FactOf<"call.settled">["data"][K];
    } = {
      callId: call.callId,
      outcome:
        outcome.status === "completed"
          ? "completed"
          : outcome.status === "failed"
            ? "failed"
            : "interrupted",
    };
    if (outcome.status === "completed" && outcome.output !== undefined) {
      const first = input.calls[0];
      if (index === 0 || first === undefined) data.output = outcome.output;
      else data.outputOf = { callId: first.callId };
    }
    if (outcome.status === "failed") data.error = { code: "TASK_FAILED", message: outcome.error };
    if (outcome.status === "cancelled") data.reason = outcome.reason ?? "task-cancelled";
    return { data, type: "call.settled" };
  });
  return unchanged(view, settled);
}

/** A task's body ended. Replying only settles calls; it never ends a resumable task. */
export function endTask(
  view: SessionView,
  input: {
    readonly taskId: string;
    readonly outcome: TaskCallOutcome;
  },
): Transition {
  const tables = view.projection.view;
  const row = tables.tasks[input.taskId];
  if (row === undefined || row.status === "ended") return unchanged(view, []);
  const { outcome } = input;
  // The writer closes what the task still holds before this (`cascade`).
  const data: FactOf<"task.ended">["data"] = {
    outcome: outcome.status,
    taskId: input.taskId,
    ...(outcome.status === "failed" && {
      error: { code: "TASK_FAILED", message: outcome.error },
    }),
    ...(outcome.status === "cancelled" && { reason: outcome.reason ?? "task-ended" }),
  };
  return unchanged(view, [{ data, type: "task.ended" }]);
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
  const tables = view.projection.view;
  const withdrawn = Object.values(tables.interactions).filter(
    (row) =>
      row.status === "open" &&
      (ids.has(row.interactionId) ||
        (run.taskId !== undefined && interactionOwner(tables, row).taskId === run.taskId)),
  );
  return unchanged(
    view,
    withdrawn.map((row) => withdrawInteraction(row.interactionId, "asker-ended")),
  );
}

/** An interaction nobody needs anymore; the writer withdraws the answers still open on it. */
function withdrawInteraction(
  interactionId: string,
  reason: string,
  outcome: "withdrawn" | "interrupted" = "withdrawn",
): SessionEvent {
  return interactionSettled(interactionId, outcome, { reason });
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * A child session or workflow run relays one of its interaction facts. The session mirrors each
 * as its own interaction, about the call it serves, with the asker as its origin: a request
 * opens, and records where its answers go; the asker's settlement closes it; and the asker's
 * admission or refusal of an answer this session forwarded applies to the forwarded copy. The
 * open turn waits on a request about one of its calls; a task's request waits on the task.
 */
export function relay(
  view: SessionView,
  input: {
    readonly payload: SubagentInteractionHookPayload;
    /** The workflow tool run that relays the request, and the hook its `ctx.ask()` answers reach. */
    readonly runId?: string;
    readonly workflowAsk?: WorkflowAskRoute;
  },
): Transition {
  const { payload } = input;
  const tables = view.projection.view;
  const route: Relay | undefined =
    payload.route === undefined
      ? undefined
      : {
          ...payload.route,
          ...(input.workflowAsk !== undefined && { workflowAsk: input.workflowAsk }),
          ...(input.runId !== undefined && { runId: input.runId }),
        };
  const events: SessionEvent[] = [];
  const upsert: Record<string, Relay> = {};
  const retire: string[] = [];
  for (const event of payload.events) {
    const interactionId = event.data.interactionId;
    const mirror = tables.interactions[interactionId];
    switch (event.type) {
      case "interaction.opened": {
        if (mirror !== undefined) break;
        events.push({
          data: {
            ...event.data,
            // Every relayed request names its asker; one relayed from further down names its own.
            origin: event.data.origin ?? { interactionId, sessionId: payload.childSessionId },
            subject: { callId: payload.callId },
          },
          type: "interaction.opened",
        });
        // A person answers it here, and the answer goes back the way it came.
        if (route !== undefined && event.data.request.kind !== "sign-in")
          upsert[interactionId] = route;
        break;
      }
      case "interaction.settled":
        if (mirror?.status !== "open") break;
        events.push(...mirrorSettled(tables, event.data));
        retire.push(interactionId);
        break;
      case "response.admitted": {
        // The asker admitted an answer this session forwarded: it stands here too, while the
        // rest of its batch waits.
        const answer = mirror === undefined ? undefined : forwardedAnswer(tables, event.data);
        if (answer !== undefined && tables.responses[answer]?.status === "submitted")
          events.push(responseAdmitted(answer));
        break;
      }
      case "response.settled": {
        // How the asker settled an answer this session forwarded; a deciding one settles with
        // its interaction.
        const answer = mirror === undefined ? undefined : forwardedAnswer(tables, event.data);
        if (answer !== undefined && event.data.outcome !== "applied")
          events.push(responseSettled(answer, event.data.outcome, event.data.reason));
        break;
      }
    }
  }
  const relays = {
    ...(Object.keys(upsert).length > 0 && { upsert }),
    ...(retire.length > 0 && { retire }),
  };
  return Object.keys(relays).length > 0
    ? { ...unchanged(view, events), relays }
    : unchanged(view, events);
}

/** The asker settled what this session mirrors: the mirror settles the same way. */
function mirrorSettled(
  tables: PublicView,
  settled: FactOf<"interaction.settled">["data"],
): SessionEvent[] {
  const open = Object.values(tables.responses)
    .filter((row) => row.interactionId === settled.interactionId && row.status !== "settled")
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const decided =
    settled.outcome === "accepted" ||
    settled.outcome === "declined" ||
    settled.outcome === "invalid";
  // The writer withdraws the answers that didn't decide (`cascade`).
  const decider = decided ? open.at(-1) : undefined;
  const events: SessionEvent[] =
    decider === undefined ? [] : [responseSettled(decider.responseId, "applied", settled.reason)];
  const data: { -readonly [K in keyof typeof settled]: (typeof settled)[K] } = { ...settled };
  if (decider !== undefined) data.cause = { responseId: decider.responseId };
  events.push({ data, type: "interaction.settled" });
  return events;
}

/** The answer this session forwarded that an asker's settlement is about. */
function forwardedAnswer(
  tables: PublicView,
  settled: { readonly interactionId: string; readonly deliveryId?: string },
): string | undefined {
  const open = Object.values(tables.responses)
    .filter((row) => row.interactionId === settled.interactionId && row.status !== "settled")
    .sort((a, b) => a.introducedAt - b.introducedAt);
  return (
    open.find((row) => settled.deliveryId !== undefined && row.deliveryId === settled.deliveryId) ??
    open.at(-1)
  )?.responseId;
}

/**
 * Answers to requests this session relays went on to their askers. Each delivery that carried
 * such answers is admitted here, with the answers it forwarded: a message that answered joins
 * the turn that asked, one that also carries input for this session goes on to its turn, and
 * any other took effect once forwarded. A question this session decides settles now; an
 * approval stays open until its asker settles it.
 */
export function routeAnswer(
  view: SessionView,
  input: {
    readonly deliveries: readonly {
      readonly deliveryId: string;
      readonly principal?: Principal;
      readonly source?: DeliverySource;
      /** A message that answered: the turn that asked consumes it. */
      readonly consumed?: { readonly turnId: string; readonly parts: readonly UserPart[] };
      /** The delivery also carries input for this session, whose turn consumes and settles it. */
      readonly continues?: true;
    }[];
    /** Every answer forwarded, as admitted. */
    readonly forwarded: readonly ResponseSubmittedData[];
    /**
     * Relayed requests this session settles as it forwards their answer, because nobody else
     * will before it acts: a workflow run's `ctx.ask()` question, since a run publishes nothing of
     * its own, and a child's budget prompt this session stops on, since Stop ends its own turn.
     */
    readonly decided: readonly {
      readonly answer: Answer;
      readonly outcome: "accepted" | "declined";
    }[];
  },
): Transition {
  const tables = view.projection.view;
  const events: SessionEvent[] = [];
  const admitted = new Set<string>();
  for (const delivery of input.deliveries) {
    if (tables.deliveries[delivery.deliveryId] !== undefined || admitted.has(delivery.deliveryId))
      continue;
    admitted.add(delivery.deliveryId);
    const data: { deliveryId: string; principal?: Principal; source?: DeliverySource } = {
      deliveryId: delivery.deliveryId,
    };
    if (delivery.principal !== undefined) data.principal = delivery.principal;
    if (delivery.source !== undefined) data.source = delivery.source;
    events.push({ data, type: "delivery.admitted" });
    if (delivery.consumed !== undefined) {
      const { parts, turnId } = delivery.consumed;
      events.push({
        data: { deliveryId: delivery.deliveryId, parts, turnId },
        type: "delivery.consumed",
      });
    }
  }
  const known = (deliveryId: string) =>
    admitted.has(deliveryId) || tables.deliveries[deliveryId] !== undefined;
  const submitted = new Map<string, ResponseSubmittedData>();
  for (const binding of input.forwarded) {
    if (tables.responses[binding.responseId] !== undefined) continue;
    if (tables.interactions[binding.interactionId]?.status !== "open") continue;
    if (!known(binding.deliveryId)) continue;
    submitted.set(binding.responseId, binding);
    events.push(responseSubmitted(binding));
  }
  for (const { answer, outcome } of input.decided) {
    const row = tables.interactions[answer.interactionId];
    if (row?.status !== "open") continue;
    const answers = [
      ...Object.values(tables.responses)
        .filter((entry) => entry.interactionId === row.interactionId && entry.status !== "settled")
        .map((entry) => entry.responseId),
      ...[...submitted.values()]
        .filter((binding) => binding.interactionId === row.interactionId)
        .map((binding) => binding.responseId),
    ];
    // The latest answer decides; the writer withdraws the others (`cascade`).
    const decider = answers.at(-1);
    if (decider !== undefined) events.push(responseSettled(decider, "applied"));
    events.push(
      interactionSettled(row.interactionId, outcome, {
        cause: decider === undefined ? undefined : { responseId: decider },
        response: answer,
      }),
    );
  }
  for (const delivery of input.deliveries) {
    if (
      delivery.consumed !== undefined ||
      delivery.continues === true ||
      !admitted.has(delivery.deliveryId)
    )
      continue;
    events.push({
      data: { deliveryId: delivery.deliveryId, outcome: "applied" },
      type: "delivery.settled",
    });
  }
  // The answered routes retire, so a later delivery can't route through them.
  const retire = input.decided.map(({ answer }) => answer.interactionId);
  return { ...unchanged(view, events), ...(retire.length > 0 && { relays: { retire } }) };
}

/**
 * A workflow run's sign-in, reported to the session that owns the run, which mirrors it: opened
 * while the run waits, then how it settled.
 */
export function runSignIn(
  from: { readonly taskId?: string; readonly turnId: string },
  challenge: AuthorizationChallenge,
  outcome?: "accepted" | "failed",
): RelayedInteractionEvent {
  if (outcome === undefined) {
    return {
      data: signInOpened(challenge, {
        prompt: `Sign in to ${challenge.name} to continue.`,

        subject: from.taskId === undefined ? { turnId: from.turnId } : { taskId: from.taskId },
      }).data,
      type: "interaction.opened",
    };
  }
  return {
    data: {
      interactionId: signInInteractionId(challenge),
      outcome,
    },
    type: "interaction.settled",
  };
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

/**
 * Sign-in callbacks arrived: each attempt the session still waits on is accepted. A callback is a
 * delivery whose response carries no value: the provider's payload stays private, and the
 * public record says only that the attempt completed.
 */
export function completeSignIn(
  view: SessionView,
  input: { readonly completions: readonly AuthorizationChallenge[] },
): Transition {
  const tables = view.projection.view;
  return unchanged(
    view,
    input.completions.flatMap((challenge): SessionEvent[] => {
      const interactionId = signInInteractionId(challenge);
      const row = tables.interactions[interactionId];
      if (row?.status !== "open") return [];
      // One callback per attempt reaches the session, so the attempt names its delivery.
      const deliveryId = `callback_${interactionId}`;
      const responseId = `response_${deliveryId}`;
      return [
        { data: { deliveryId, source: { callback: "authorization" } }, type: "delivery.admitted" },
        responseSubmitted({ deliveryId, interactionId, responseId }),
        responseSettled(responseId, "applied"),
        interactionSettled(interactionId, "accepted", { cause: { responseId } }),
        deliveryApplied(deliveryId),
      ];
    }),
  );
}

// ---------------------------------------------------------------------------
// Cancel and clear
// ---------------------------------------------------------------------------

/** Requests this session asked itself and still awaits; relayed requests answer elsewhere. */
export function ownOpenRequestIds(view: Omit<SessionView, "turn">): ReadonlySet<string> {
  return new Set(
    openRequests(view.projection.view)
      .filter(
        (row) =>
          row.origin === undefined &&
          interactionOwner(view.projection.view, row).taskId === undefined &&
          !view.relayedRequestIds.has(row.interactionId),
      )
      .map((row) => row.interactionId),
  );
}

/**
 * The delivery a clear or compact arrived as. One that names none, from a caller that predates
 * control ids, is named by the position it applies at.
 */
export function controlDeliveryFor(view: SessionView, given?: ControlDelivery): ControlDelivery {
  return given ?? { deliveryId: `control_${String(view.projection.view.position)}` };
}

/** A control's admission: the delivery it arrived as, its kind, and who sent it. */
export function controlAdmitted(delivery: ControlDelivery, control: string): SessionEvent {
  const data: { -readonly [K in keyof DeliveryAdmittedData]: DeliveryAdmittedData[K] } = {
    deliveryId: delivery.deliveryId,
    source: { control },
  };
  if (delivery.principal !== undefined) data.principal = delivery.principal;
  return { data, type: "delivery.admitted" };
}

/** A control or callback delivery's settlement once what it asked has happened. */
export function deliveryApplied(deliveryId: string): SessionEvent {
  return { data: { deliveryId, outcome: "applied" }, type: "delivery.settled" };
}

/**
 * A control's transition as a delivery: admitted before what it changes and applied after, in
 * the same commit, with what it changes naming it as the cause. A control that names no
 * delivery changes the session on its own.
 */
export function controlled(
  delivery: ControlDelivery | undefined,
  control: string,
  build: (cause: Cause | undefined) => Transition,
): Transition {
  if (delivery === undefined) return build(undefined);
  const transition = build({ deliveryId: delivery.deliveryId });
  return {
    ...transition,
    events: [
      controlAdmitted(delivery, control),
      ...transition.events,
      deliveryApplied(delivery.deliveryId),
    ],
  };
}

/** What the model reads for a call its turn's cancellation stopped before the call settled. */
export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

/**
 * `session.cancel()`: the open turn ends cancelled. Its requests, its sign-ins, and every
 * relayed request are withdrawn, since the cancel stops the work that asked them; its unsettled
 * calls are stopped. The steps it ran commit to history, each unfinished call answered as
 * cancelled, so the model sees that the work started and stopped.
 */
export function cancel(view: SessionView, input: { readonly cause?: Cause } = {}): Transition {
  const { projection } = view;
  const turnId = activeTurnIdOf(projection);
  const stopped = view.turn.suspended.filter(
    (step) =>
      (turnId !== undefined && step.event.turnId === turnId) ||
      step.tasks.some((task) => !answeredCallIds(step.messages).has(task.callId)),
  );
  const stoppedRequestIds = new Set(
    stopped.flatMap((step) => step.requests.map((request) => request.interactionId)),
  );
  const tables = projection.view;
  // The cancel also stops the work behind every relayed request and the stopped steps' asks,
  // wherever they sit; the writer closes the rest of what the turn held.
  const events: SessionEvent[] = Object.values(tables.interactions)
    .filter(
      (row) =>
        row.status === "open" &&
        (view.relayedRequestIds.has(row.interactionId) ||
          stoppedRequestIds.has(row.interactionId) ||
          row.request.kind === "budget"),
    )
    .map((row) => withdrawInteraction(row.interactionId, "Cancelled.", "interrupted"));
  events.push(
    ...closeTurn(
      projection,
      { cause: input.cause, outcome: "cancelled" },
      activeTurn(tables)?.turnId ?? turnId,
    ),
  );
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
export function clear(
  view: SessionView,
  input: { readonly sessionId: string; readonly cause?: Cause },
): Transition {
  const { projection } = view;
  const changeId = nextChangeId(projection);
  return {
    clearsHistory: true,
    events: [
      ...clearedInteractions(view),
      // Clear runs between turns. A paused turn still owns a lifecycle; end it and its
      // non-task work before selecting an empty conversation, instead of dropping only its
      // private suspended steps and leaving the public turn and calls open forever.
      ...closeTurn(projection, { cause: input.cause, outcome: "cancelled" }),
      contextStarted({ cause: input.cause, changeId, kind: "clear" }),
      {
        data: { changeId, kind: "clear", outcome: "completed", selects: null },
        type: "context.settled",
      },
    ],
    turn: { grants: view.turn.grants, suspended: [] } satisfies TurnState,
  };
}

/**
 * What a clear withdraws: every request the cleared history asked for, its turn's too. Requests
 * relayed from live tasks stay.
 */
function clearedInteractions(view: SessionView): SessionEvent[] {
  const tables = view.projection.view;
  return Object.values(tables.interactions)
    .filter((row) => row.status === "open" && !view.relayedRequestIds.has(row.interactionId))
    .map((row) =>
      withdrawInteraction(row.interactionId, "The context was cleared.", "interrupted"),
    );
}

/** A context change starts. */
export function contextStarted(input: {
  readonly changeId: string;
  readonly kind: string;
  readonly turnId?: string;
  readonly cause?: Cause;
  readonly trigger?: { readonly inputTokens: number };
}): FactOf<"context.started"> {
  const data: {
    -readonly [K in keyof FactOf<"context.started">["data"]]: FactOf<"context.started">["data"][K];
  } = {
    changeId: input.changeId,
    kind: input.kind,
  };
  if (input.turnId !== undefined) data.turnId = input.turnId;
  if (input.cause !== undefined) data.cause = input.cause;
  if (input.trigger !== undefined) data.trigger = input.trigger;
  return input.turnId === undefined
    ? { data, type: "context.started" }
    : { data, type: "context.started" };
}
