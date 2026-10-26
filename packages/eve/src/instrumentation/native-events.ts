import type { DeliverHookPayload } from "#channel/types.js";
import { instrumentationScope } from "#instrumentation/scope.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { contextStorage } from "#context/container.js";
import { deliveryEvent } from "#instrumentation/channel-delivery.js";
import type {
  InstrumentationScope,
  InstrumentationEvent,
  InstrumentationHooks,
  InstrumentationParentLineage,
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
import { askedCall, decidingAnswer } from "#protocol/session-projection/reader.js";
import { callRun, runTurn } from "#protocol/session-projection/selectors.js";
import { copyView, foldReceivedEvent } from "#protocol/session-projection/fold.js";
import type { InteractionRow, SessionView } from "#protocol/session-projection/tables.js";
import type { HandleEventFn } from "#harness/types.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

export interface CreateInstrumentationHandleEventInput {
  readonly deliveryInput?: DeliverHookPayload;
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
  readonly runId: string;
  readonly turnId?: string;
  readonly stepIndex?: number;
  readonly attempt: number;
}

/** An attempt's scope: the session it runs in, and its place. */
export function attemptScopeOf(
  session: Pick<
    CreateInstrumentationHandleEventInput,
    "channelAudience" | "functionId" | "rootSessionId" | "sessionId" | "traceSessionId"
  >,
  { runId, attempt, stepIndex, turnId }: AttemptPlace,
): InstrumentationScope {
  return instrumentationScope(
    {
      runId,
      attempt,
      channelAudience: session.channelAudience,
      functionId: session.functionId,
      rootSessionId: session.rootSessionId,
      sessionId: session.sessionId,
      traceSessionId: session.traceSessionId,
      turnId,
    },
    stepIndex,
  );
}

/** What one committed line means to instrumentation, besides the line itself. */
interface Line {
  readonly attemptScope: (place: AttemptPlace) => InstrumentationScope;
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
    let cancellation: { readonly error: unknown } | undefined;
    try {
      await handleEvent(publication, messages);
    } catch (error) {
      // Turn hooks cancel after the publication commits; its instrumentation must still settle.
      if (
        !isTurnCancellation(error) ||
        before === undefined ||
        ctx === undefined ||
        currentView(ctx).position <= before.position
      )
        throw error;
      cancellation = { error };
    }
    // Operational state may already have retired a summary run when its context change settled.
    const published = eventsOf(publication);
    const committed =
      before !== undefined && published.some((event) => isTerminalType(event.type))
        ? cascade(before, published)
        : published;
    const view = before === undefined ? undefined : copyView(before);
    if (view !== undefined)
      for (const event of committed)
        foldReceivedEvent(view, { ...event, meta: { endOfLine: false } });
    const line: Line = {
      attemptScope: (place) => attemptScopeOf(input, place),
      capturesInputs: hooks.capturesInputs ?? hooks.capturesContent ?? false,
      capturesOutputs: hooks.capturesOutputs ?? hooks.capturesContent ?? false,
      settledAtMs: ctx?.get(RuntimeActionSettlementTimesKey),
      startedAtMs,
      view: view ?? (ctx === undefined ? undefined : currentView(ctx)),
    };
    for (const event of committed) {
      const delivery = deliveryEvent(event, ctx, input);
      if (delivery !== undefined) await hooks.publish(Object.freeze(delivery));
      for (const derived of instrumentationEventsOf(event, line, input)) {
        await hooks.publish(Object.freeze(derived));
      }
    }
    if (cancellation !== undefined) throw cancellation.error;
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
      const { outcome } = event.data;
      return [
        {
          error:
            outcome === "failed"
              ? new Error(event.data.error?.message ?? "The session failed.")
              : undefined,
          idempotencyKey: session,
          outcome,
          sessionId,
          turnId,
          type: "session.ended",
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
      return [
        {
          error:
            outcome === "failed"
              ? new Error(event.data.error?.message ?? "The turn failed.")
              : undefined,
          idempotencyKey: turnIdempotencyKey(sessionId, turnId),
          outcome,
          sessionId,
          turnId,
          type: "turn.settled",
        },
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
          type: "model.retried",
        },
      ];
    }
    case "model.settled": {
      const scope = runAttempt(line, event.data.runId);
      if (scope === undefined) return [];
      const { error, outcome } = event.data;
      const idempotencyKey = attemptIdempotencyKey(scope);
      // A cancelled turn stops its run on purpose: the attempt is cancelled, not failed.
      const cancelled =
        outcome === "interrupted" &&
        scope.turnId !== undefined &&
        line.view?.turns[scope.turnId]?.outcome === "cancelled";
      return [
        {
          error: error === undefined ? undefined : new Error(error.message),
          idempotencyKey,
          scope,
          outcome: cancelled ? "cancelled" : outcome,
          type: "model.settled",
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
          capability,
          scope,
          startedAtMs: line.startedAtMs,
          toolName: name,
          type: "call.requested",
        },
      ];
    }
    case "call.settled": {
      const { callId, outcome } = event.data;
      const row = line.view?.calls[callId];
      const scope = row === undefined ? undefined : runAttempt(line, callRun(line.view!, row));
      if (scope === undefined) return [];
      const idempotencyKey = actionIdempotencyKey(sessionId, scope.turnId, callId);
      const output = outcome === "completed" ? event.data.output : undefined;
      const error =
        outcome === "completed"
          ? undefined
          : event.data.error === undefined
            ? event.data.output
            : Object.assign(new Error(event.data.error.message), {
                code: event.data.error.code,
                name: event.data.error.name ?? "Error",
              });
      return [
        {
          acceptedAtMs: line.settledAtMs?.[callId],
          cause: event.data.cause,
          error: line.capturesOutputs ? error : undefined,
          errorCode: event.data.error?.code,
          idempotencyKey,
          outcome,
          reason: event.data.reason,
          output: line.capturesOutputs ? output : undefined,
          scope,
          type: "call.settled",
          usage: row?.usage,
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
                title: request.title,
              }
            : undefined,
          scope,
          type: "interaction.opened",
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
          type: "interaction.settled",
        },
      ];
    }
    default:
      return [];
  }
}

/** A turn's run's current attempt; a context change's run is no step of a turn. */
function runAttempt(line: Line, runId: string | undefined): InstrumentationScope | undefined {
  const run = runId === undefined ? undefined : line.view?.runs[runId];
  if (run?.attempt === undefined) return undefined;
  const turnId = runTurn(line.view!, run.runId);
  return line.attemptScope({ runId: run.runId, attempt: run.attempt, stepIndex: run.step, turnId });
}

/**
 * The attempt a person's request came from: its call's, or for a request about the turn or a
 * task, the turn's latest. Sign-ins are connection work, not input.
 */
function interactionAttempt(line: Line, row: InteractionRow): InstrumentationScope | undefined {
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

function turnSequence(turnId: string): number {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? 0 : Number(match[1]);
}
