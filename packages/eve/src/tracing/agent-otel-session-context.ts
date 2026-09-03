import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import {
  type InstrumentationSessionStartedEvent,
  type InstrumentationTraceContext,
  type InstrumentationTraceSeed,
  type InstrumentationTurnStartedEvent,
} from "#instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#tracing/sampled-trace.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import {
  agentInvocationSpanName,
  type AgentSamplingOperation,
} from "#tracing/agent-span-contract.js";
import { agentActivationAttributes } from "#tracing/agent-otel-runtime-context.js";
import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";

interface AgentOtelSessionContextInput {
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace?: (traceId: string, operation?: AgentSamplingOperation) => boolean;
  readonly stateStore: AgentTraceStateStore;
  readonly tracePolicy?: TraceCapturePolicy;
}

type SessionMetadata = Omit<InstrumentationSessionStartedEvent, "idempotencyKey" | "type">;

interface AgentOtelSessionContext {
  readonly ensureSessionContext: (event: SessionMetadata) => Promise<AgentSessionTraceState>;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
}

export function createAgentOtelSessionContext(
  input: AgentOtelSessionContextInput,
): AgentOtelSessionContext {
  const ensureSessionContext = async (event: SessionMetadata): Promise<AgentSessionTraceState> => {
    let state = await input.stateStore.getSession(event.sessionId);
    if (state === undefined) {
      const channelAudience = normalizeChannelAudience(event.channelAudience);
      const decision = resolveSessionTraceDecision(event, channelAudience, input.tracePolicy);
      state = {
        agentName: event.agentName,
        channelAudience,
        channelKind: event.channelKind,
        decision,
        context: initialSessionContext(input, event, decision),
        rootSessionId: event.rootSessionId,
        parentLineage: event.parentLineage,
      };
      await input.stateStore.setSession(event.sessionId, state);
    }
    return state;
  };

  const prepareSessionTrace = async (
    event: InstrumentationSessionStartedEvent,
  ): Promise<InstrumentationTraceSeed> => {
    const session = await ensureSessionContext(event);
    return portableSpanContext(session.context, session.decision);
  };

  const prepareTurnTrace = async (
    event: InstrumentationTurnStartedEvent,
  ): Promise<InstrumentationTraceSeed> => {
    const prepared = await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (prepared !== undefined) {
      const session = await input.stateStore.getSession(event.sessionId);
      return portableSpanContext(prepared.context, session?.decision);
    }

    const session = await ensureSessionContext(event);
    const useInitialContext = event.sequence === 0;
    const caller = useInitialContext ? event.parentTraceContext : undefined;
    let turnContext = useInitialContext
      ? { ...session.context, isRemote: false }
      : freshTurnContext(input, event.idempotencyKey, session.decision);
    const turn: AgentTurnTraceState = {
      caller: caller === undefined ? undefined : adoptedSpanContext(caller),
      context: turnContext,
      currentPrincipal: event.currentPrincipal,
      initiatorPrincipal: event.initiatorPrincipal,
      parentLineage: event.parentLineage ?? session.parentLineage,
      rootSessionId: event.rootSessionId,
      sequence: event.sequence,
      startTimeMs: Date.now(),
      subagentName: (event.parentLineage ?? session.parentLineage)?.subagentName,
    };
    if (isSampledTrace(turn.context)) {
      const agentName = session.agentName ?? turn.subagentName;
      const sampled =
        input.samplesTrace?.(turn.context.traceId, {
          name: agentInvocationSpanName(agentName),
          attributes: agentActivationAttributes({
            agentName,
            frameworkVersion: input.frameworkVersion,
            sessionId: event.sessionId,
            turnId: event.turnId,
            turn,
          }),
        }) ?? true;
      turnContext = { ...turnContext, traceFlags: sampled ? 1 : 0 };
    }
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      ...turn,
      context: turnContext,
    });
    return portableSpanContext(turnContext, session.decision);
  };

  return { ensureSessionContext, prepareSessionTrace, prepareTurnTrace };
}

function portableSpanContext(
  spanContext: SpanContext,
  decision?: InstrumentationTraceSeed["decision"],
): InstrumentationTraceSeed {
  return {
    decision,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
  };
}

function adoptedSpanContext(handed: InstrumentationTraceContext): SpanContext {
  return {
    isRemote: "isRemote" in handed && handed.isRemote === true,
    spanId: handed.spanId,
    traceFlags: handed.traceFlags,
    traceId: handed.traceId,
  };
}

function initialSessionContext(
  input: AgentOtelSessionContextInput,
  event: SessionMetadata,
  decision: ReturnType<typeof resolveTracePolicy>,
): SpanContext {
  const handed = event.traceSeed;
  if (handed !== undefined) {
    return {
      ...adoptedSpanContext(handed),
      traceFlags: decision.action === "drop" ? 0 : handed.traceFlags,
    };
  }
  const traceId = input.idGenerator.deriveTraceId(`session:${event.sessionId}`);
  const sampled = decision.action === "record";
  return {
    isRemote: false,
    spanId: input.idGenerator.deriveSpanId(`session:${event.sessionId}`),
    traceFlags: sampled ? 1 : 0,
    traceId,
  };
}

function freshTurnContext(
  input: AgentOtelSessionContextInput,
  idempotencyKey: string,
  decision: AgentSessionTraceState["decision"],
): SpanContext {
  const traceId = input.idGenerator.deriveTraceId(`turn:${idempotencyKey}`);
  const sampled = decision?.action === "record";
  return {
    isRemote: false,
    spanId: input.idGenerator.deriveSpanId(`turn:${idempotencyKey}`),
    traceFlags: sampled ? 1 : 0,
    traceId,
  };
}

function resolveSessionTraceDecision(
  event: SessionMetadata,
  audience: ChannelAudience,
  policy: TraceCapturePolicy | undefined,
): ReturnType<typeof resolveTracePolicy> {
  if (event.parentTraceContext !== undefined && !isSampledTrace(event.parentTraceContext)) {
    return { action: "drop" };
  }
  if (event.traceSeed?.decision !== undefined) {
    return readInstrumentationDecision(event.traceSeed.decision) ?? { action: "drop" };
  }
  if (event.traceSeed !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.traceSeed), audience);
  }
  if (event.parentTraceContext !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.parentTraceContext), audience);
  }
  if (event.agentName === undefined) {
    return policy === undefined ? resolveTracePolicyDecision(true, audience) : { action: "drop" };
  }
  // The tool loop can evaluate the same policy before this first-session
  // preparation path; the persisted decision removes that window on replay.
  return resolveTracePolicy(policy, {
    agentName: event.agentName,
    audience,
    channelType: event.channelType,
  });
}
