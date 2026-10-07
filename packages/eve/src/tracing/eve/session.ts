import type { SpanContext } from "@opentelemetry/api";

import {
  type InstrumentationSessionStartedEvent,
  type InstrumentationTraceContext,
  type InstrumentationTraceSeed,
  type InstrumentationTurnStartedEvent,
  type InstrumentationTurnTerminalEvent,
  type InstrumentationSessionTransitionEvent,
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
import { eveCapture, eveTurnIdentity } from "#tracing/eve/operation-input.js";
import type { AgentTurnTraceState } from "#tracing/eve/agent-trace-state.js";
import { applyPrincipalTraceDecision } from "#instrumentation/principal-summary.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import { traceSessionIdOf } from "#tracing/eve/operation-input.js";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { withOperationConversation } from "#tracing/eve/conversation-context.js";
import type {
  AgentSpanIdGenerator,
  AgentTracing,
  ExecutionContext,
  TraceLink,
  TurnOperation,
} from "#tracing/lib/index.js";

interface EveSessionTracingInput {
  readonly tracing: AgentTracing;
  readonly idGenerator: AgentSpanIdGenerator;
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
  /** Hydrates a turn this process or an earlier one started. */
  turnFor(
    sessionId: string,
    turnId: string,
    context?: ExecutionContext,
  ): Promise<TurnOperation | undefined>;
  turnTerminal(event: InstrumentationTurnTerminalEvent): Promise<void>;
  sessionTransition(event: InstrumentationSessionTransitionEvent): Promise<void>;
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

  const turnKey = (sessionId: string, turnId: string) => JSON.stringify([sessionId, turnId]);

  async function turnFor(sessionId: string, turnId: string, context?: ExecutionContext) {
    const turn = await input.stateStore.get("turn", turnKey(sessionId, turnId));
    if (turn === undefined || !isSampledTrace(turn.context)) return undefined;
    const session = await input.stateStore.get("session", sessionId);
    return input.tracing.resume({
      identity: eveTurnIdentity({ sessionId, rootSessionId: turn.rootSessionId, turnId }),
      context: context ?? hostContext(session?.channelAudience, { sessionId, ...turn }),
    });
  }

  const prepareTurnTrace = async (
    event: InstrumentationTurnStartedEvent,
  ): Promise<InstrumentationTraceSeed> => {
    const prepared = await input.stateStore.get("turn", turnKey(event.sessionId, event.turnId));
    if (prepared !== undefined) {
      const session = await input.stateStore.get("session", event.sessionId);
      return portableSpanContext(prepared.context, session?.decision);
    }

    const session = await ensureSessionContext(event);
    const useInitialContext = event.sequence === 0;
    const caller = useInitialContext ? event.parentTraceContext : undefined;
    const emit = session.decision?.action === "record";
    // A local caller's first child turn joins the caller's trace beneath its call.
    const nested = caller !== undefined && !("isRemote" in caller && caller.isRemote === true);
    const reserved = useInitialContext
      ? {
          ...session.context,
          traceId: nested ? caller.traceId : session.context.traceId,
          isRemote: false,
        }
      : {
          traceId: input.idGenerator.deriveTraceId(`turn:${event.idempotencyKey}`),
          spanId: input.idGenerator.deriveSpanId(`turn:${event.idempotencyKey}`),
          traceFlags: emit ? 1 : 0,
          isRemote: false,
        };
    const agentName =
      session.agentName ?? (event.parentLineage ?? session.parentLineage)?.subagentName;
    let turn: AgentTurnTraceState = {
      agentName,
      caller: caller === undefined ? undefined : adoptedSpanContext(caller),
      context: reserved,
      currentPrincipal: applyPrincipalTraceDecision(event.currentPrincipal, session.decision),
      initiatorPrincipal: applyPrincipalTraceDecision(event.initiatorPrincipal, session.decision),
      parentLineage: event.parentLineage ?? session.parentLineage,
      rootSessionId: event.rootSessionId,
      traceSessionId: traceSessionIdOf(event),
      sequence: event.sequence,
      startTimeMs: Date.now(),
      subagentName: (event.parentLineage ?? session.parentLineage)?.subagentName,
    };
    if (isSampledTrace(reserved)) {
      const operation = await input.tracing.turn({
        ...eveActivationMetadata({ session, turn, sessionId: event.sessionId }),
        agentName,
        identity: eveTurnIdentity({ ...event, sessionId: event.sessionId }),
        framework: { name: "eve", version: input.frameworkVersion },
        capture: eveCapture(reserved),
        reference: reserved,
        parent: nested ? adoptedSpanContext(caller) : undefined,
        links: activationLinks(turn),
        startTimeMs: turn.startTimeMs,
        context: hostContext(session.channelAudience, event),
      });
      turn = { ...turn, context: { ...reserved, traceFlags: operation.reference.traceFlags } };
    }
    await input.stateStore.set("turn", turnKey(event.sessionId, event.turnId), turn);
    return portableSpanContext(turn.context, session.decision);
  };

  async function recordTerminal(
    sessionId: string,
    turnId: string,
    terminal: NonNullable<AgentTurnTraceState["terminal"]>,
    error?: unknown,
  ) {
    await input.stateStore.update("turn", turnKey(sessionId, turnId), (turn) => ({
      ...turn,
      terminal:
        terminal.outcome !== "failed"
          ? terminal
          : {
              outcome: "failed",
              errorName: error instanceof Error ? error.name : undefined,
              errorMessage: error instanceof Error ? error.message : undefined,
            },
    }));
  }

  return {
    ensureSessionContext,
    prepareSessionTrace,
    prepareTurnTrace,
    turnFor,
    async turnTerminal(event) {
      await recordTerminal(
        event.sessionId,
        event.turnId,
        {
          outcome:
            event.type === "turn.failed"
              ? "failed"
              : event.type === "turn.cancelled"
                ? "cancelled"
                : "completed",
        },
        event.type === "turn.failed" ? event.error : undefined,
      );
    },
    async sessionTransition(event) {
      if (event.turnId === undefined) return;
      if (event.type === "session.failed")
        await recordTerminal(event.sessionId, event.turnId, { outcome: "failed" }, event.error);
      const turn = await input.stateStore.get("turn", turnKey(event.sessionId, event.turnId));
      if (turn === undefined) return;
      const session = await input.stateStore.get("session", event.sessionId);
      const operation = await turnFor(event.sessionId, event.turnId);
      if (operation !== undefined) {
        const metadata = eveActivationMetadata({ session, turn, sessionId: event.sessionId });
        operation.attributes(metadata.attributes ?? {});
        operation.links(activationLinks(turn) ?? []);
        const terminal = turn.terminal;
        // A turn the session left without a terminal event ends with no outcome, as on main.
        if (terminal === undefined) await operation.complete({ outcomeUnknown: true });
        else if (terminal.outcome === "failed") {
          const error = new Error(terminal.errorMessage);
          error.name = terminal.errorName ?? "Error";
          await operation.complete({
            outcome: "failed",
            failed: true,
            error,
            errorType: terminal.errorName,
          });
        } else await operation.complete({ outcome: terminal.outcome });
      }
      await input.stateStore.delete("turn", turnKey(event.sessionId, event.turnId));
    },
  };
}

/** Spans this process starts inherit the channel audience and the operation's conversation. */
function hostContext(
  audience: ChannelAudience | undefined,
  operation: { readonly sessionId: string; readonly rootSessionId?: string },
) {
  return withOperationConversation(withChannelAudience(ROOT_CONTEXT, audience), operation);
}

function activationLinks(turn: AgentTurnTraceState): TraceLink[] | undefined {
  const links: TraceLink[] = [];
  // A local caller is the turn's parent; only a remote one is linked.
  if (turn.caller?.isRemote === true)
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
  const key = `session:${event.sessionId}`;
  const parent = event.parentTraceContext;
  const local = parent !== undefined && !("isRemote" in parent && parent.isRemote === true);
  return {
    traceId: local ? parent.traceId : input.idGenerator.deriveTraceId(key),
    spanId: input.idGenerator.deriveSpanId(key),
    traceFlags: decision.action === "record" ? 1 : 0,
  };
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
