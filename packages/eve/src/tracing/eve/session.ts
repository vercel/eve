import type { SpanContext } from "@opentelemetry/api";

import {
  type InstrumentationSessionStartedEvent,
  type InstrumentationTraceContext,
  type InstrumentationTraceSeed,
  type InstrumentationTurnStartedEvent,
  type InstrumentationTurnTerminalEvent,
  type InstrumentationSessionTransitionEvent,
  type InstrumentationUsage,
} from "#instrumentation/lifecycle.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/eve/otel-declaration.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#shared/trace-policy.js";
import type {
  AgentSessionTraceState,
  AgentTraceStateStore,
} from "#tracing/eve/agent-trace-state.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import { eveActivationMetadata } from "#tracing/eve/metadata.js";
import { eveOperationInput } from "#tracing/eve/operation-input.js";
import type { AgentTurnTraceState } from "#tracing/eve/agent-trace-state.js";
import { applyPrincipalTraceDecision } from "#instrumentation/principal-summary.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import { traceSessionIdOf } from "#tracing/eve/operation-input.js";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import type { TraceLink, DurableTraceRuntime } from "#tracing/lib/index.js";

interface EveSessionTracingInput {
  readonly lifecycle: DurableTraceRuntime;
  readonly environment: ConversationEnvironment;
  readonly frameworkVersion: string;
  readonly stateStore: AgentTraceStateStore;
  readonly tracePolicy?: TraceCapturePolicy;
}

type SessionMetadata = Omit<InstrumentationSessionStartedEvent, "idempotencyKey" | "type">;

interface EveSessionTracing {
  readonly ensureSessionContext: (event: SessionMetadata) => Promise<AgentSessionTraceState>;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  turnTerminal(event: InstrumentationTurnTerminalEvent): Promise<void>;
  sessionTransition(event: InstrumentationSessionTransitionEvent): Promise<void>;
  recordModelUsage(sessionId: string, turnId: string, usage: InstrumentationUsage): Promise<void>;
}

export function createEveSessionTracing(input: EveSessionTracingInput): EveSessionTracing {
  const ensureSessionContext = async (event: SessionMetadata): Promise<AgentSessionTraceState> => {
    let state = await input.stateStore.get("session", event.sessionId);
    if (state === undefined) {
      const channelAudience = normalizeChannelAudience(event.channelAudience);
      const decision = resolveSessionTraceDecision(
        event,
        channelAudience,
        input.environment,
        input.tracePolicy,
      );
      state = {
        agentName: event.agentName,
        channelAudience,
        channelKind: event.channelKind,
        channelType: event.channelType,
        decision,
        context: initialSessionContext(input, event, decision),
        parentLineage: event.parentLineage,
        rootSessionId: event.rootSessionId,
        traceSessionId: traceSessionIdOf(event),
        scheduleId: event.scheduleId,
        title: event.title,
      };
      await input.stateStore.set("session", event.sessionId, state);
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
    const prepared = await input.stateStore.get(
      "turn",
      JSON.stringify([event.sessionId, event.turnId]),
    );
    if (prepared !== undefined) {
      const session = await input.stateStore.get("session", event.sessionId);
      return portableSpanContext(prepared.context, session?.decision);
    }

    const session = await ensureSessionContext(event);
    const useInitialContext = event.sequence === 0;
    const caller = useInitialContext ? event.parentTraceContext : undefined;
    let turnContext = useInitialContext
      ? { ...session.context, isRemote: false }
      : input.lifecycle.turnReference(event.idempotencyKey, {
          emit: session.decision?.action === "record",
          recordInputs: false,
          recordOutputs: false,
        });
    const turn: AgentTurnTraceState = {
      caller: caller === undefined ? undefined : adoptedSpanContext(caller),
      context: turnContext,
      currentPrincipal: applyPrincipalTraceDecision(event.currentPrincipal, session.decision),
      initiatorPrincipal: applyPrincipalTraceDecision(event.initiatorPrincipal, session.decision),
      parentLineage: event.parentLineage ?? session.parentLineage,
      rootSessionId: event.rootSessionId,
      traceSessionId: traceSessionIdOf(event),
      sequence: event.sequence,
      startTimeMs: Date.now(),
      subagentName: (event.parentLineage ?? session.parentLineage)?.subagentName,
    };
    const operation = await input.lifecycle.turn({
      ...eveOperationInput(
        {
          ...turn,
          sessionId: event.sessionId,
          turnId: event.turnId,
          agentName: session.agentName ?? turn.subagentName,
          frameworkVersion: input.frameworkVersion,
          reference: turnContext,
          links: activationLinks(turn),
        },
        `${event.sessionId}:${event.turnId}`,
      ),
      metadata: eveActivationMetadata({ session, turn, sessionId: event.sessionId }),
    });
    if (isSampledTrace(turnContext) && !input.lifecycle.sample(operation.snapshot())) {
      turnContext = { ...turnContext, traceFlags: 0 };
    }
    await input.stateStore.set("turn", JSON.stringify([event.sessionId, event.turnId]), {
      ...turn,
      context: turnContext,
      snapshot: operation.snapshot(),
    });
    return portableSpanContext(turnContext, session.decision);
  };

  return {
    ensureSessionContext,
    prepareSessionTrace,
    prepareTurnTrace,
    async turnTerminal(event) {
      await input.stateStore.update(
        "turn",
        JSON.stringify([event.sessionId, event.turnId]),
        (turn) => ({
          ...turn,
          snapshot: input.lifecycle.checkpoint(turn.snapshot, {
            terminal:
              event.type === "turn.failed"
                ? { outcome: "failed", failed: true, error: event.error }
                : { outcome: event.type === "turn.cancelled" ? "cancelled" : "completed" },
          }),
        }),
      );
    },
    async sessionTransition(event) {
      if (event.type === "session.failed" && event.turnId !== undefined)
        await input.stateStore.update(
          "turn",
          JSON.stringify([event.sessionId, event.turnId]),
          (turn) => ({
            ...turn,
            snapshot: input.lifecycle.checkpoint(turn.snapshot, {
              terminal: { outcome: "failed", failed: true, error: event.error },
            }),
          }),
        );
      if (event.turnId === undefined) return;
      const turn = await input.stateStore.get(
        "turn",
        JSON.stringify([event.sessionId, event.turnId]),
      );
      if (turn === undefined) return;
      const session = await input.stateStore.get("session", event.sessionId);
      if (isSampledTrace(turn.context)) {
        const metadata = eveActivationMetadata({ session, turn, sessionId: event.sessionId });
        const host = withChannelAudience(ROOT_CONTEXT, session?.channelAudience);
        const resumed =
          turn.snapshot === undefined
            ? undefined
            : await input.lifecycle.resume(turn.snapshot, { context: host });
        const runtime = resumed?.type === "activation" ? resumed : undefined;
        runtime?.update({ attributes: metadata.attributes, links: activationLinks(turn) });
        await runtime?.complete();
      }
      await input.stateStore.delete("turn", JSON.stringify([event.sessionId, event.turnId]));
    },
    async recordModelUsage(sessionId, turnId, usage) {
      if (usage.inputTokens === undefined && usage.outputTokens === undefined) return;
      // Workflow replay restarts from pre-step state; distinct completed retries count.
      await input.stateStore.update("turn", JSON.stringify([sessionId, turnId]), (turn) => ({
        ...turn,
        snapshot: input.lifecycle.checkpoint(turn.snapshot, { usage }),
      }));
    },
  };
}

function activationLinks(turn: AgentTurnTraceState): TraceLink[] | undefined {
  const links: TraceLink[] = [];
  if (turn.caller !== undefined)
    links.push({ context: turn.caller, relationship: "agent.dispatch" });
  if (turn.channelDelivery?.requestTraceContext !== undefined)
    links.push({
      context: turn.channelDelivery.requestTraceContext,
      relationship: "channel.request",
    });
  return links.length === 0 ? undefined : links;
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
  input: EveSessionTracingInput,
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
  return input.lifecycle.session(
    {
      conversationId: event.rootSessionId ?? event.sessionId,
      runId: event.sessionId,
      turnId: "",
      framework: { name: "eve", version: input.frameworkVersion },
    },
    { emit: decision.action === "record", recordInputs: false, recordOutputs: false },
  );
}

function resolveSessionTraceDecision(
  event: SessionMetadata,
  audience: ChannelAudience,
  environment: ConversationEnvironment,
  policy: TraceCapturePolicy | undefined,
): ReturnType<typeof resolveTracePolicy> {
  const content = { audience, environment };
  if (event.parentTraceContext !== undefined && !isSampledTrace(event.parentTraceContext)) {
    return { action: "drop" };
  }
  if (event.traceSeed?.decision !== undefined) {
    return readInstrumentationDecision(event.traceSeed.decision) ?? { action: "drop" };
  }
  if (event.traceSeed !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.traceSeed), content);
  }
  if (event.parentTraceContext !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.parentTraceContext), content);
  }
  if (event.agentName === undefined) {
    return policy === undefined ? resolveTracePolicyDecision(true, content) : { action: "drop" };
  }
  // The tool loop can evaluate the same policy before this first-session
  // preparation path; the persisted decision removes that window on replay.
  return resolveTracePolicy(policy, {
    agentName: event.agentName,
    audience,
    channel: {
      kind: normalizeInstrumentationChannelKind(event.channelKind ?? event.channelType),
    },
    environment,
    principalType: "unknown",
  });
}
