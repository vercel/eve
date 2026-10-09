import type { SessionEvent } from "#protocol/session-event.js";
import { contextStorage } from "#context/container.js";
import { instrumentChannelDelivery } from "#instrumentation/channel-delivery.js";
import type {
  InstrumentationToolCallFailedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationAttemptScope,
  InstrumentationHooks,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationParentLineage,
  InstrumentationPointEvent,
  InstrumentationTraceContext,
} from "#instrumentation/lifecycle.js";
import {
  actionIdempotencyKey,
  inputIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
  toolCallIdempotencyKey,
} from "#instrumentation/lifecycle.js";
import {
  rememberInstrumentationActionScope,
  rememberInstrumentationInputScope,
  takeInstrumentationActionScopeForCall,
  takeInstrumentationInputScope,
} from "#instrumentation/state.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import { eventsOf } from "#harness/publication.js";
import type { HandleEventFn } from "#harness/types.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

export interface CreateInstrumentationHandleEventInput {
  readonly isFrameworkTool?: (name: string) => boolean;
  readonly traceSessionId?: string;
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly channelAudience?: ChannelAudience;
  readonly getAttemptScope?: () => InstrumentationAttemptScope | undefined;
  readonly handleEvent?: HandleEventFn;
  readonly hooks?: InstrumentationHooks;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId?: string;
  readonly scheduleId?: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly turnId?: string;
}

/** Publishes eve-native lifecycle transitions after durable event acceptance. */
export function createInstrumentationHandleEvent(
  input: CreateInstrumentationHandleEventInput,
): HandleEventFn | undefined {
  if (input.hooks === undefined) return input.handleEvent;
  if (input.handleEvent === undefined) return undefined;

  const handleEvent = input.handleEvent;
  const hooks = input.hooks;
  const publishedActions = new Set<string>();
  const publishedInputs = new Set<string>();
  let activeTurnId = input.turnId;
  return async (publication, messages) => {
    const startedAtMs = Date.now();
    await handleEvent(publication, messages);
    for (const event of eventsOf(publication)) {
      activeTurnId = await instrumentEvent(event, activeTurnId, startedAtMs);
    }
  };

  async function instrumentEvent(
    event: SessionEvent,
    turnId: string | undefined,
    startedAtMs: number,
  ): Promise<string | undefined> {
    let activeTurnId = turnId;
    const lifecycleEvents = toLifecycleEvents(event, input, activeTurnId);
    if (event.type === "turn.started") activeTurnId = event.data.turnId;
    const ending = deliveryEnding(event);
    if (ending !== undefined) {
      const ctx = contextStorage.getStore();
      if (ctx !== undefined) await instrumentChannelDelivery({ ctx, hooks, ...ending });
    }
    for (const lifecycleEvent of lifecycleEvents) await hooks.publish(lifecycleEvent);
    if (event.type === "call.requested") {
      await publishActionStart(event, input, hooks, publishedActions, startedAtMs, activeTurnId);
    } else if (event.type === "call.settled") {
      await publishActionTerminal(event, input, hooks);
    } else if (event.type === "input.requested") {
      await publishInputStarts(event, input, hooks, publishedInputs);
    }
    return activeTurnId;
  }
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
  if (event.type === "turn.settled") {
    const { error, outcome } = event.data;
    return {
      error: error === undefined ? undefined : new Error(error.message),
      errorCode: error?.code,
      includeTurn: true,
      outcome,
    };
  }
  if (event.type === "session.ended") {
    const { error, outcome } = event.data;
    return {
      error: error === undefined ? undefined : new Error(error.message),
      errorCode: error?.code,
      includeTurn: outcome === "failed",
      outcome,
    };
  }
  return undefined;
}

async function publishInputStarts(
  event: Extract<SessionEvent, { type: "input.requested" }>,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
  published: Set<string>,
): Promise<void> {
  const scope = input.getAttemptScope?.();
  if (scope === undefined) return;
  const capturesOutputs = hooks.capturesOutputs ?? hooks.capturesContent;

  for (const request of event.data.requests) {
    const idempotencyKey = inputIdempotencyKey(
      input.sessionId,
      event.data.turnId,
      request.requestId,
    );
    if (published.has(idempotencyKey)) continue;
    published.add(idempotencyKey);
    rememberInstrumentationInputScope(idempotencyKey, scope);
    await hooks.publish(
      Object.freeze({
        action: Object.freeze({
          callId: request.action.callId,
          name: request.action.toolName,
        }),
        idempotencyKey,
        kind: request.kind,
        request: capturesOutputs
          ? Object.freeze({
              allowFreeform: request.allowFreeform,
              display: request.display,
              options: request.options,
              prompt: request.prompt,
            })
          : undefined,
        requestId: request.requestId,
        scope,
        type: "input.requested",
      } satisfies InstrumentationInputRequestedEvent),
    );
  }
}

/** Publishes accepted input resolutions against their original request scope. */
export async function publishInputResolutions(input: {
  readonly batch: ResolvedInputBatch;
  readonly hooks: InstrumentationHooks;
  readonly sessionId: string;
}): Promise<void> {
  const capturesInputs = input.hooks.capturesInputs ?? input.hooks.capturesContent;
  for (const resolved of input.batch.inputs) {
    const idempotencyKey = inputIdempotencyKey(
      input.sessionId,
      input.batch.event.turnId,
      resolved.request.requestId,
    );
    const scope = takeInstrumentationInputScope(idempotencyKey);
    if (scope === undefined) continue;
    await input.hooks.publish(
      Object.freeze({
        idempotencyKey,
        kind: resolved.request.kind,
        outcome: resolved.outcome,
        requestId: resolved.request.requestId,
        response:
          !capturesInputs || resolved.response === undefined
            ? undefined
            : Object.freeze({
                optionId: resolved.response.optionId,
                text: resolved.response.text,
              }),
        scope,
        type: "input.resolved",
      } satisfies InstrumentationInputResolvedEvent),
    );
  }
}

async function publishActionStart(
  event: FactOf<"call.requested">,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
  published: Set<string>,
  startedAtMs: number,
  turnId: string | undefined,
): Promise<void> {
  const scope = input.getAttemptScope?.();
  if (scope === undefined) return;
  const capturesInputs = hooks.capturesInputs ?? hooks.capturesContent;
  const { callId, capability } = event.data;
  const name = capability.name;
  // Agent calls run in their own sessions; the runtime reports their start.
  const deferred = capability.kind === "agent";
  const idempotencyKey = actionIdempotencyKey(input.sessionId, turnId ?? "", callId);
  if (published.has(idempotencyKey)) return;
  published.add(idempotencyKey);
  // A skill load runs eve's skill loader; any other call is eve's when its tool is.
  const frameworkTool = capability.kind === "skill" || input.isFrameworkTool?.(name) === true;
  rememberInstrumentationActionScope(
    idempotencyKey,
    scope,
    deferred
      ? {
          type: "tool.call.started",
          callId,
          toolName: name,
          frameworkTool,
          scope,
          idempotencyKey: toolCallIdempotencyKey(scope, callId, 0),
          startedAtMs: Date.now(),
          input: capturesInputs ? event.data.input : undefined,
        }
      : undefined,
  );
  const started: {
    -readonly [
      K in keyof InstrumentationToolCallStartedEvent
    ]: InstrumentationToolCallStartedEvent[K];
  } = {
    callId,
    frameworkTool,
    idempotencyKey,
    input: capturesInputs ? event.data.input : undefined,
    kind:
      capability.kind === "agent"
        ? "subagent-call"
        : capability.kind === "skill"
          ? "load-skill"
          : "tool-call",
    scope,
    startedAtMs,
    toolName: name,
    type: "tool.call.started",
  };
  if (deferred) started.isWorkflowTool = true;
  await hooks.publish(Object.freeze(started));
}

async function publishActionTerminal(
  event: FactOf<"call.settled">,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
): Promise<void> {
  const { callId } = event.data;
  const correlation = takeInstrumentationActionScopeForCall(input.sessionId, callId);
  if (correlation === undefined) return;
  const { idempotencyKey, scope } = correlation;
  const capturesOutputs = hooks.capturesOutputs ?? hooks.capturesContent;
  const acceptedAtMs = contextStorage.getStore()?.get(RuntimeActionSettlementTimesKey)?.[callId];

  if (event.data.outcome === "completed") {
    await hooks.publish(
      Object.freeze({
        acceptedAtMs,
        idempotencyKey,
        outcome: "completed",
        output: Object.freeze(
          capturesOutputs ? { output: event.data.output, type: "result" } : { type: "result" },
        ),
        scope,
        type: "tool.call.completed",
      }),
    );
    return;
  }

  const error = capturesOutputs
    ? event.data.error === undefined
      ? event.data.output
      : Object.assign(new Error(event.data.error.message), { code: event.data.error.code })
    : undefined;
  await hooks.publish(
    Object.freeze({
      acceptedAtMs,
      error,
      errorCode: event.data.error?.code,
      idempotencyKey,
      outcome: event.data.outcome === "rejected" ? "rejected" : "failed",
      scope,
      type: "tool.call.failed",
    } satisfies InstrumentationToolCallFailedEvent),
  );
}

function toLifecycleEvents(
  event: SessionEvent,
  input: CreateInstrumentationHandleEventInput,
  activeTurnId: string | undefined,
): InstrumentationPointEvent[] {
  switch (event.type) {
    case "session.started":
      return [
        {
          agentName: input.agentName,
          channelAudience: input.channelAudience,
          channelKind: input.channelKind,
          idempotencyKey: sessionIdempotencyKey(input.sessionId),
          parentLineage: input.parentLineage,
          parentTraceContext: input.parentTraceContext,
          rootSessionId: input.rootSessionId ?? input.sessionId,
          traceSessionId: input.traceSessionId,
          scheduleId: input.scheduleId,
          sessionId: input.sessionId,
          title: input.title,
          type: "session.started",
        },
      ];
    case "session.ended":
      return event.data.outcome === "completed"
        ? [
            {
              idempotencyKey: sessionIdempotencyKey(input.sessionId),
              sessionId: input.sessionId,
              turnId: activeTurnId,
              type: "session.completed",
            },
          ]
        : [
            {
              error: new Error(event.data.error?.message ?? "The session failed."),
              idempotencyKey: sessionIdempotencyKey(input.sessionId),
              sessionId: input.sessionId,
              turnId: activeTurnId,
              type: "session.failed",
            },
          ];
    case "turn.started":
      return [
        {
          idempotencyKey: turnIdempotencyKey(input.sessionId, event.data.turnId),
          parentLineage: input.parentLineage,
          parentTraceContext: input.parentTraceContext,
          rootSessionId: input.rootSessionId ?? input.sessionId,
          traceSessionId: input.traceSessionId,
          sequence: turnSequence(event.data.turnId),
          sessionId: input.sessionId,
          turnId: event.data.turnId,
          type: "turn.started",
        },
      ];
    case "turn.settled": {
      const key = turnIdempotencyKey(input.sessionId, event.data.turnId);
      const ended: InstrumentationPointEvent =
        event.data.outcome === "failed"
          ? {
              error: new Error(event.data.error?.message ?? "The turn failed."),
              idempotencyKey: key,
              sessionId: input.sessionId,
              turnId: event.data.turnId,
              type: "turn.failed",
            }
          : {
              idempotencyKey: key,
              sessionId: input.sessionId,
              turnId: event.data.turnId,
              type: event.data.outcome === "cancelled" ? "turn.cancelled" : "turn.completed",
            };
      // Instrumentation still marks the session waiting once a turn ends.
      return [
        ended,
        {
          idempotencyKey: sessionIdempotencyKey(input.sessionId),
          sessionId: input.sessionId,
          turnId: event.data.turnId,
          type: "session.waiting",
        },
      ];
    }
    default:
      return [];
  }
}

function turnSequence(turnId: string): number {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? 0 : Number(match[1]);
}
