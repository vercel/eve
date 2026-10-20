import type { SessionEvent } from "#protocol/session-event.js";
import { contextStorage } from "#context/container.js";
import { instrumentChannelDelivery } from "#instrumentation/channel-delivery.js";
import type {
  InstrumentationAttemptScope,
  InstrumentationEvent,
  InstrumentationHooks,
  InstrumentationParentLineage,
  InstrumentationToolCallOutcome,
  InstrumentationTraceContext,
} from "#instrumentation/lifecycle.js";
import {
  actionIdempotencyKey,
  attemptIdempotencyKey,
  inputIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#instrumentation/lifecycle.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import { currentView, enteredView } from "#harness/session-machine/current.js";
import { isTerminalType } from "#protocol/session-events/catalog.js";
import { askedCall, decidingAnswer } from "#protocol/session-reader.js";
import { callRun, runTurn } from "#protocol/session-projection/selectors.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import type { HandleEventFn } from "#harness/types.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

export interface CreateInstrumentationHandleEventInput {
  readonly isFrameworkTool?: (name: string) => boolean;
  readonly functionId?: string;
  readonly traceSessionId?: string;
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly channelAudience?: ChannelAudience;
  readonly handleEvent?: HandleEventFn;
  readonly hooks?: InstrumentationHooks;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId?: string;
  readonly scheduleId?: string;
  readonly sessionId: string;
  readonly title?: string;
}

/** Where an attempt is in its session: its turn, its step, and which try at the step it is. */
export interface AttemptPlace {
  readonly turnId: string;
  readonly stepIndex: number;
  readonly attemptIndex: number;
}

/** An attempt's scope: the session it runs in, and its place. */
export function attemptScopeOf(
  session: Pick<
    CreateInstrumentationHandleEventInput,
    "channelAudience" | "functionId" | "rootSessionId" | "sessionId" | "traceSessionId"
  >,
  { attemptIndex, stepIndex, turnId }: AttemptPlace,
): InstrumentationAttemptScope {
  return {
    attemptId: `${session.sessionId}:${turnId}:${stepIndex}:${attemptIndex}`,
    attemptIndex,
    channelAudience: session.channelAudience,
    functionId: session.functionId,
    rootSessionId: session.rootSessionId,
    sessionId: session.sessionId,
    stepIndex,
    traceSessionId: session.traceSessionId,
    turnId,
  };
}

/** What one committed line means to instrumentation, besides the line itself. */
interface Line {
  readonly attemptScope: (place: AttemptPlace) => InstrumentationAttemptScope;
  readonly capturesInputs: boolean;
  readonly capturesOutputs: boolean;
  readonly settledAtMs?: Readonly<Record<string, number>>;
  readonly startedAtMs: number;
  readonly view?: SessionView;
}

/**
 * Publishes each committed fact's instrumentation events once the publication folds it. The
 * events are a function of the fact and the tables after it: a call's or a request's attempt is
 * its run's current one, the attempt that produced it.
 */
export function createInstrumentationHandleEvent(
  input: CreateInstrumentationHandleEventInput,
): HandleEventFn | undefined {
  if (input.hooks === undefined) return input.handleEvent;
  if (input.handleEvent === undefined) return undefined;
  const { handleEvent, hooks } = input;
  return async (publication, messages) => {
    const startedAtMs = Date.now();
    const ctx = contextStorage.getStore();
    const before = ctx === undefined ? undefined : enteredView(ctx);
    await handleEvent(publication, messages);
    const line: Line = {
      attemptScope: (place) => attemptScopeOf(input, place),
      capturesInputs: hooks.capturesInputs ?? hooks.capturesContent ?? false,
      capturesOutputs: hooks.capturesOutputs ?? hooks.capturesContent ?? false,
      settledAtMs: ctx?.get(RuntimeActionSettlementTimesKey),
      startedAtMs,
      view: ctx === undefined ? undefined : currentView(ctx),
    };
    // The writer commits what an owner's end closes along with it; instrumentation hears that
    // commit, folded on the tables as they stood.
    const published = eventsOf(publication);
    const committed =
      before !== undefined && published.some((event) => isTerminalType(event.type))
        ? cascade(before, published)
        : published;
    for (const event of committed) {
      const ending = deliveryEnding(event);
      if (ending !== undefined && ctx !== undefined)
        await instrumentChannelDelivery({ ctx, hooks, ...ending });
      for (const derived of instrumentationEventsOf(event, line, input)) {
        await hooks.publish(Object.freeze(derived));
      }
    }
  };
}

/** The instrumentation events one fact produces. */
function instrumentationEventsOf(
  event: SessionEvent,
  line: Line,
  input: CreateInstrumentationHandleEventInput,
): InstrumentationEvent[] {
  const { sessionId } = input;
  const session = sessionIdempotencyKey(sessionId);
  switch (event.type) {
    case "session.started":
      return [
        {
          agentName: input.agentName,
          channelAudience: input.channelAudience,
          channelKind: input.channelKind,
          idempotencyKey: session,
          parentLineage: input.parentLineage,
          parentTraceContext: input.parentTraceContext,
          rootSessionId: input.rootSessionId ?? sessionId,
          traceSessionId: input.traceSessionId,
          scheduleId: input.scheduleId,
          sessionId,
          title: input.title,
          type: "session.started",
        },
      ];
    case "session.ended": {
      // The turn that failed it, when one did; otherwise the session's latest turn.
      const { cause } = event.data;
      const turnId =
        cause !== undefined && "turnId" in cause ? cause.turnId : latestTurnId(line.view);
      return [
        event.data.outcome === "completed"
          ? { idempotencyKey: session, sessionId, turnId, type: "session.completed" }
          : {
              error: new Error(event.data.error?.message ?? "The session failed."),
              idempotencyKey: session,
              sessionId,
              turnId,
              type: "session.failed",
            },
      ];
    }
    case "turn.started":
      return [
        {
          idempotencyKey: turnIdempotencyKey(sessionId, event.data.turnId),
          parentLineage: input.parentLineage,
          parentTraceContext: input.parentTraceContext,
          rootSessionId: input.rootSessionId ?? sessionId,
          traceSessionId: input.traceSessionId,
          sequence: turnSequence(event.data.turnId),
          sessionId,
          turnId: event.data.turnId,
          type: "turn.started",
        },
      ];
    case "turn.settled": {
      const { outcome, turnId } = event.data;
      const idempotencyKey = turnIdempotencyKey(sessionId, turnId);
      return [
        outcome === "failed"
          ? {
              error: new Error(event.data.error?.message ?? "The turn failed."),
              idempotencyKey,
              sessionId,
              turnId,
              type: "turn.failed",
            }
          : {
              idempotencyKey,
              sessionId,
              turnId,
              type: outcome === "cancelled" ? "turn.cancelled" : "turn.completed",
            },
        // Instrumentation still marks the session waiting once a turn ends.
        { idempotencyKey: session, sessionId, turnId, type: "session.waiting" },
      ];
    }
    case "model.retried": {
      const scope = runAttempt(line, event.data.runId);
      if (scope === undefined) return [];
      return [
        {
          error: new Error(event.data.error.message),
          idempotencyKey: attemptIdempotencyKey(scope),
          scope,
          type: "step.attempt.failed",
        },
      ];
    }
    case "model.settled": {
      const scope = runAttempt(line, event.data.runId);
      if (scope === undefined) return [];
      const { error, outcome } = event.data;
      const idempotencyKey = attemptIdempotencyKey(scope);
      // A cancelled turn stops its run on purpose: the attempt ended without failing.
      const cancelled =
        outcome === "interrupted" && line.view?.turns[scope.turnId]?.outcome === "cancelled";
      return [
        outcome === "completed" || cancelled
          ? { idempotencyKey, scope, type: "step.attempt.completed" }
          : {
              error: error === undefined ? undefined : new Error(error.message),
              idempotencyKey,
              scope,
              type: "step.attempt.failed",
            },
      ];
    }
    case "call.requested": {
      const row = line.view?.calls[event.data.callId];
      const scope = row === undefined ? undefined : runAttempt(line, callRun(line.view!, row));
      if (scope === undefined) return [];
      const { callId, capability } = event.data;
      const name = capability.name;
      return [
        {
          callId,
          // A skill load runs eve's skill loader; any other call is eve's when its tool is.
          frameworkTool: capability.kind === "skill" || input.isFrameworkTool?.(name) === true,
          idempotencyKey: actionIdempotencyKey(sessionId, scope.turnId, callId),
          input: line.capturesInputs ? event.data.input : undefined,
          // Agent calls run in their own sessions, which report their own start.
          ...(capability.kind === "agent" ? { isWorkflowTool: true } : undefined),
          kind:
            capability.kind === "agent"
              ? "subagent-call"
              : capability.kind === "skill"
                ? "load-skill"
                : "tool-call",
          scope,
          startedAtMs: line.startedAtMs,
          toolName: name,
          type: "tool.call.started",
        },
      ];
    }
    case "call.settled": {
      const { callId, outcome } = event.data;
      const row = line.view?.calls[callId];
      const scope = row === undefined ? undefined : runAttempt(line, callRun(line.view!, row));
      if (scope === undefined) return [];
      const idempotencyKey = actionIdempotencyKey(sessionId, scope.turnId, callId);
      const acceptedAtMs = line.settledAtMs?.[callId];
      const usage = row?.usage === undefined ? undefined : { usage: row.usage };
      if (outcome === "completed") {
        return [
          {
            acceptedAtMs,
            idempotencyKey,
            outcome,
            output: line.capturesOutputs
              ? { output: event.data.output, type: "result" }
              : { type: "result" },
            scope,
            type: "tool.call.completed",
            ...usage,
          },
        ];
      }
      const error = !line.capturesOutputs
        ? undefined
        : event.data.error === undefined
          ? event.data.output
          : Object.assign(new Error(event.data.error.message), { code: event.data.error.code });
      return [
        {
          acceptedAtMs,
          error,
          errorCode: event.data.error?.code,
          idempotencyKey,
          outcome: CALL_FAILURES[outcome] ?? "failed",
          scope,
          type: "tool.call.failed",
          ...usage,
        },
      ];
    }
    case "interaction.opened": {
      const row = line.view?.interactions[event.data.interactionId];
      const scope = row === undefined ? undefined : interactionAttempt(line, row);
      if (row === undefined || scope === undefined) return [];
      const { request } = row;
      const call = askedCall(line.view!, row);
      return [
        {
          call: call === undefined ? undefined : { callId: call.callId, name: call.name },
          idempotencyKey: inputIdempotencyKey(sessionId, scope.turnId, row.interactionId),
          interactionId: row.interactionId,
          kind: request.kind,
          request: line.capturesOutputs
            ? {
                allowFreeform: request.allowFreeform,
                display: request.display,
                options: request.options,
                prompt: request.prompt,
              }
            : undefined,
          scope,
          type: "input.requested",
        },
      ];
    }
    case "interaction.settled": {
      const row = line.view?.interactions[event.data.interactionId];
      const scope = row === undefined ? undefined : interactionAttempt(line, row);
      if (row === undefined || scope === undefined) return [];
      const answer = decidingAnswer(row);
      return [
        {
          answer:
            !line.capturesInputs || answer === undefined
              ? undefined
              : { optionId: answer.optionId, text: answer.text },
          idempotencyKey: inputIdempotencyKey(sessionId, scope.turnId, row.interactionId),
          interactionId: row.interactionId,
          kind: row.request.kind,
          outcome: event.data.outcome,
          scope,
          type: "input.resolved",
        },
      ];
    }
    default:
      return [];
  }
}

const CALL_FAILURES: Partial<Record<string, Exclude<InstrumentationToolCallOutcome, "completed">>> =
  {
    abandoned: "abandoned",
    interrupted: "cancelled",
    rejected: "rejected",
  };

/** A turn's run's current attempt; a context change's run is no step of a turn. */
function runAttempt(
  line: Line,
  runId: string | undefined,
): InstrumentationAttemptScope | undefined {
  const run = runId === undefined ? undefined : line.view?.runs[runId];
  if (run?.step === undefined || run.attempt === undefined) return undefined;
  const turnId = runTurn(line.view!, run.runId);
  if (turnId === undefined) return undefined;
  return line.attemptScope({ attemptIndex: run.attempt, stepIndex: run.step, turnId });
}

/**
 * The attempt a person's request came from: its call's, or for a request about the turn or a
 * task, the turn's latest. Sign-ins are connection work, not input.
 */
function interactionAttempt(
  line: Line,
  row: InteractionRow,
): InstrumentationAttemptScope | undefined {
  const view = line.view!;
  if (row.request.kind === "sign-in") return undefined;
  const { subject } = row;
  if ("callId" in subject) {
    const call = view.calls[subject.callId];
    return call === undefined ? undefined : runAttempt(line, callRun(view, call));
  }
  if ("taskId" in subject) {
    const task = view.tasks[subject.taskId];
    const call = task === undefined ? undefined : view.calls[task.startedBy.callId];
    return call === undefined ? undefined : runAttempt(line, callRun(view, call));
  }
  if (!("turnId" in subject)) return undefined;
  const runs = Object.values(view.runs).filter(
    (run) => run.attempt !== undefined && runTurn(view, run.runId) === subject.turnId,
  );
  return runAttempt(line, runs.at(-1)?.runId);
}

function latestTurnId(view: SessionView | undefined): string | undefined {
  const ids = view === undefined ? [] : Object.keys(view.turns);
  return ids.at(-1);
}

/** How a turn's or session's end ends the channel delivery it served. */
function deliveryEnding(event: SessionEvent):
  | {
      readonly error?: Error;
      readonly errorCode?: string;
      readonly includeTurn: boolean;
      readonly outcome: "completed" | "failed" | "cancelled";
    }
  | undefined {
  if (event.type !== "turn.settled" && event.type !== "session.ended") return undefined;
  const { error, outcome } = event.data;
  return {
    error: error === undefined ? undefined : new Error(error.message),
    errorCode: error?.code,
    includeTurn: event.type === "turn.settled" || outcome === "failed",
    outcome,
  };
}

function turnSequence(turnId: string): number {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? 0 : Number(match[1]);
}
