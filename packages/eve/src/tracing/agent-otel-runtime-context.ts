import type { AgentSessionTraceState, AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import type { InstrumentationStepAttemptStartedEvent } from "#instrumentation/lifecycle.js";
import { agentSpanNamingAttributes } from "#tracing/agent-span-naming.js";
import { agentInvocationSpanName } from "#tracing/agent-span-contract.js";
import { agentTraceIdentityAttributes, traceSessionIdOf } from "#tracing/agent-otel-attributes.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
import { runtimeContextAttributes as traceRuntimeContextAttributes } from "#tracing/core/attributes.js";
import { frameworkAttributes } from "#tracing/core/attributes.js";

type SpanAttributePrimitive = string | number | boolean;
type SpanAttributeValue = SpanAttributePrimitive | SpanAttributePrimitive[];

export function agentActivationAttributes(input: {
  readonly agentName?: string;
  readonly frameworkVersion: string;
  readonly session?: AgentSessionTraceState;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turn: AgentTurnTraceState;
}): Record<string, string | number | boolean | undefined> {
  const recordsTrace = input.session?.decision?.action === "record";
  const recordsInputs = recordsTrace && input.session?.decision?.recordInputs === true;
  const recordsOutputs = recordsTrace && input.session?.decision?.recordOutputs === true;
  const parentLineage = input.turn.parentLineage ?? input.session?.parentLineage;
  const isSubagent = parentLineage !== undefined;
  const ownsSessionMetadata = !isSubagent || input.turn.traceSessionId === input.sessionId;
  const channelClassification = agentChannelClassificationAttributes(
    input.session,
    input.turn,
    input.sessionId,
  );
  const scheduleId = isSubagent ? undefined : input.session?.scheduleId;
  return {
    ...frameworkAttributes({ name: "eve", version: input.frameworkVersion }),
    "agent.name": input.agentName,
    "agent.channel.audience": input.session?.channelAudience,
    ...agentPrincipalAttributes(input.turn),
    "agent.channel.delivery.id": input.turn.channelDelivery?.deliveryId,
    "agent.channel.delivery.input": input.turn.channelDelivery?.inputAttribute,
    ...channelClassification,
    "agent.channel.name": input.turn.channelDelivery?.channelName,
    "agent.channel.request.id": input.turn.channelDelivery?.requestId,
    "agent.parent_call.id": parentLineage?.callId,
    "agent.parent_run.id": parentLineage?.sessionId,
    "agent.run.type": isSubagent ? "subagent" : "session",
    "agent.schedule.id": scheduleId,
    "agent.session.title": ownsSessionMetadata && recordsInputs ? input.session?.title : undefined,
    "agent.subagent.name": input.turn.subagentName,
    "agent.trace.content.input": recordsInputs,
    "agent.trace.content.output": recordsOutputs,
    "agent.turn.id": input.turnId,
    "agent.turn.sequence": input.turn.sequence,
    "gen_ai.agent.name": input.agentName,
    "gen_ai.operation.name": "invoke_agent",
    ...agentSpanNamingAttributes(agentInvocationSpanName(input.agentName), "invoke_agent"),
    ...agentTraceIdentityAttributes({
      rootSessionId: input.turn.rootSessionId,
      traceSessionId: input.turn.traceSessionId,
      sessionId: input.sessionId,
    }),
  };
}

export function agentChannelClassificationAttributes(
  session: AgentSessionTraceState | undefined,
  turn: AgentTurnTraceState,
  sessionId: string,
): {
  readonly "agent.channel.kind": string | undefined;
  readonly "agent.session.origin": string | undefined;
} {
  const isSubagent = (turn.parentLineage ?? session?.parentLineage) !== undefined;
  const ownsSessionMetadata = !isSubagent || turn.traceSessionId === sessionId;
  const channelKind =
    turn.channelDelivery?.channelKind ??
    (!ownsSessionMetadata
      ? undefined
      : (session?.channelKind ??
        (session?.channelType === undefined
          ? undefined
          : normalizeInstrumentationChannelKind(session.channelType))));
  const origin =
    !ownsSessionMetadata || channelKind === undefined
      ? undefined
      : session?.scheduleId !== undefined
        ? "schedule"
        : "channel";
  return {
    "agent.channel.kind": channelKind,
    "agent.session.origin": origin,
  };
}

export function agentStepAttributes(input: {
  readonly event: InstrumentationStepAttemptStartedEvent;
  readonly frameworkVersion: string;
  readonly session?: AgentSessionTraceState;
  readonly turn: AgentTurnTraceState;
}) {
  const { event, session, turn } = input;
  const channelClassification = agentChannelClassificationAttributes(
    session,
    turn,
    event.scope.sessionId,
  );
  return {
    ...frameworkAttributes({ name: "eve", version: input.frameworkVersion }),
    "agent.step.attempt": event.scope.attemptIndex,
    "agent.step.index": event.scope.stepIndex,
    "agent.turn.id": event.scope.turnId,
    "agent.name": event.scope.functionId,
    // Leave an unresolved kind open for a later delivery to classify.
    ...(channelClassification["agent.channel.kind"] === "unknown"
      ? undefined
      : channelClassification),
    ...agentSpanNamingAttributes("agent.step"),
    ...agentTraceIdentityAttributes({
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      traceSessionId: traceSessionIdOf(event.scope),
      sessionId: event.scope.sessionId,
    }),
    ...runtimeContextAttributes(event.runtimeContext),
  };
}

export function agentPrincipalAttributes(turn: AgentTurnTraceState): Record<string, string> {
  const attributes: Record<string, string> = {};
  setOptionalAttribute(attributes, "agent.principal.current.id", turn.currentPrincipal?.id);
  setOptionalAttribute(attributes, "agent.principal.current.type", turn.currentPrincipal?.type);
  setOptionalAttribute(attributes, "agent.principal.initiator.id", turn.initiatorPrincipal?.id);
  setOptionalAttribute(attributes, "agent.principal.initiator.type", turn.initiatorPrincipal?.type);
  return attributes;
}

/** Flattens merged runtime context into AI SDK-compatible span attributes. */
export function runtimeContextAttributes(
  runtimeContext: Readonly<Record<string, unknown>> | undefined,
): Record<string, SpanAttributeValue> {
  const attributes: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(traceRuntimeContextAttributes(runtimeContext))) {
    if (value !== undefined) attributes[key] = value as SpanAttributeValue;
  }
  return attributes;
}

function setOptionalAttribute(
  attributes: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) attributes[key] = value;
}
