import type { ChannelInstrumentationProjection, SessionTraceContext } from "#channel/types.js";
import { ConversationIdKey } from "#context/keys.js";
import { readConversationId } from "#tracing/conversation-context.js";
import type { RuntimeSubagentChildResult, RuntimeSubagentResult } from "#shared/action-types.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import {
  applyLiveDeliveryAudienceCeiling,
  readForwardedTraceAssertion,
} from "#shared/forwarded-trace-policy.js";
import { deriveAgentActionSpanId } from "#tracing/agent-span-id-generator.js";
import {
  readActionTraceContext,
  recordActionInvocationKind,
  recordNestedAgentInvocation,
  recordNestedAgentInvocationTerminal,
} from "#tracing/agent-trace-context-store.js";

export interface AgentChildTraceDispatch {
  readonly conversationId?: string;
  readonly originAudience: ChannelAudience;
  readonly parentTraceContext?: SessionTraceContext;
}

export function prepareAgentInvocationTrace(input: {
  readonly channelMetadata?: ChannelInstrumentationProjection;
  readonly invocation: {
    readonly callId: string;
    readonly kind: "remote-agent-call" | "subagent-call";
    readonly name: string;
    readonly parentActionCallId?: string;
  };
  readonly parentTraceContext?: SessionTraceContext;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly turnId: string;
}): {
  readonly dispatch: AgentChildTraceDispatch;
  readonly serializedContext: Record<string, unknown>;
} {
  const parentActionCallId = input.invocation.parentActionCallId;
  const conversationId = readConversationId(input.serializedContext[ConversationIdKey.name]);
  const liveAudience = normalizeChannelAudience(input.channelMetadata?.metadata.audience);
  if (parentActionCallId === undefined) {
    return {
      dispatch: {
        conversationId,
        originAudience:
          input.parentTraceContext?.forwardedTracePolicy?.originAudience ?? liveAudience,
        parentTraceContext: input.parentTraceContext,
      },
      serializedContext: input.serializedContext,
    };
  }

  const serializedContext =
    parentActionCallId === input.invocation.callId
      ? recordActionInvocationKind({
          callId: input.invocation.callId,
          kind: input.invocation.kind,
          serializedContext: input.serializedContext,
          sessionId: input.sessionId,
          turnId: input.turnId,
        })
      : recordNestedAgentInvocation({
          callId: input.invocation.callId,
          kind: input.invocation.kind,
          name: input.invocation.name,
          outerCallId: parentActionCallId,
          serializedContext: input.serializedContext,
          sessionId: input.sessionId,
          spanId: deriveAgentActionSpanId(input.sessionId, input.turnId, input.invocation.callId),
          turnId: input.turnId,
        });
  const callerTraceContext = readActionTraceContext(
    serializedContext,
    input.sessionId,
    input.turnId,
    input.invocation.callId,
  );
  const storedParentTraceContext = callerTraceContext ?? input.parentTraceContext;
  const forwardedTracePolicy = readForwardedTraceAssertion(
    storedParentTraceContext?.forwardedTracePolicy,
  );
  const parentTraceContext =
    storedParentTraceContext?.decision === undefined
      ? storedParentTraceContext
      : {
          ...storedParentTraceContext,
          decision: applyLiveDeliveryAudienceCeiling(
            storedParentTraceContext.decision,
            liveAudience,
            forwardedTracePolicy,
          ),
        };
  return {
    dispatch: {
      conversationId,
      originAudience: forwardedTracePolicy?.originAudience ?? liveAudience,
      parentTraceContext: callerTraceContext === undefined ? undefined : parentTraceContext,
    },
    serializedContext,
  };
}

export function failAgentInvocationTrace(input: {
  readonly callId: string;
  readonly result: RuntimeSubagentResult;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly turnId: string;
}): Record<string, unknown> {
  return recordNestedAgentInvocationTerminal({
    callId: input.callId,
    serializedContext: input.serializedContext,
    sessionId: input.sessionId,
    terminal: {
      acceptedAtMs: Date.now(),
      error: invocationError(input.result.output),
      outcome: "failed",
    },
    turnId: input.turnId,
  });
}

export function settleAgentInvocationTrace(input: {
  readonly result: RuntimeSubagentChildResult;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}): Record<string, unknown> {
  const turnResult = input.result.outcome.result;
  const usage = input.result.usage ?? input.result.outcome.usageDelta;
  return recordNestedAgentInvocationTerminal({
    callId: input.result.callId,
    serializedContext: input.serializedContext,
    sessionId: input.sessionId,
    terminal: {
      acceptedAtMs: Date.now(),
      error: turnResult.kind === "failed" ? invocationError(turnResult.error) : undefined,
      outcome:
        turnResult.kind === "succeeded"
          ? "completed"
          : turnResult.kind === "cancelled"
            ? "cancelled"
            : "failed",
      usage: {
        inputTokenDetails: {
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    },
  });
}

function invocationError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    return new Error(String(value.message));
  }
  return new Error(typeof value === "string" ? value : "Agent invocation failed.");
}
