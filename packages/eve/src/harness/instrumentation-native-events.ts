import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type {
  InstrumentationHooks,
  InstrumentationParentLineage,
  InstrumentationPointEvent,
  InstrumentationTraceContext,
} from "#harness/instrumentation-lifecycle.js";
import type { HandleEventFn } from "#harness/types.js";

export interface CreateInstrumentationHandleEventInput {
  readonly agentName?: string;
  readonly handleEvent?: HandleEventFn;
  readonly hooks?: InstrumentationHooks;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId?: string;
  readonly sessionId: string;
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
  let activeTurnId = input.turnId;
  return async (event, messages) => {
    await handleEvent(event, messages);
    const lifecycleEvent = toLifecycleEvent(event, input, activeTurnId);
    if (event.type === "turn.started") activeTurnId = event.data.turnId;
    if (lifecycleEvent !== undefined) await hooks.publish(lifecycleEvent);
  };
}

function toLifecycleEvent(
  event: UnstampedMessageStreamEvent,
  input: CreateInstrumentationHandleEventInput,
  activeTurnId: string | undefined,
): InstrumentationPointEvent | undefined {
  switch (event.type) {
    case "session.started":
      return {
        agentName: input.agentName,
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        sessionId: input.sessionId,
        type: "session.started",
      };
    case "session.completed":
    case "session.waiting":
      return { sessionId: input.sessionId, turnId: activeTurnId, type: event.type };
    case "session.failed":
      return {
        error: new Error(event.data.message),
        sessionId: input.sessionId,
        turnId: activeTurnId,
        type: "session.failed",
      };
    case "turn.started":
      return {
        parentLineage: input.parentLineage,
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        sequence: event.data.sequence,
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: "turn.started",
      };
    case "turn.completed":
    case "turn.cancelled":
      return { sessionId: input.sessionId, turnId: event.data.turnId, type: event.type };
    case "turn.failed":
      return {
        error: new Error(event.data.message),
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: "turn.failed",
      };
    default:
      return undefined;
  }
}
