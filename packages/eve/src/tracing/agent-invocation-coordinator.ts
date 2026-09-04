import type { ChannelInstrumentationProjection, SessionTraceContext } from "#channel/types.js";
import type { RuntimeSubagentChildResult, RuntimeSubagentResult } from "#shared/action-types.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import {
  applyLiveDeliveryAudienceCeiling,
  decisionToTraceContentCeiling,
  readForwardedTraceAssertion,
} from "#shared/forwarded-trace-policy.js";
import { allocateChildSessionTraceSeed } from "#tracing/agent-child-trace-seed.js";
import { deriveAgentActionSpanId } from "#tracing/agent-span-id-generator.js";
import {
  readActionTraceContext,
  recordActionChildTraceId,
  recordActionInvocationKind,
  recordNestedAgentInvocation,
  recordNestedAgentInvocationTerminal,
} from "#tracing/agent-trace-context-store.js";

export interface AgentChildTraceDispatch {
  readonly originAudience: ChannelAudience;
  readonly parentTraceContext?: SessionTraceContext;
  readonly traceSeed?: SessionTraceContext;
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
  const liveAudience = normalizeChannelAudience(input.channelMetadata?.metadata.audience);
  if (parentActionCallId === undefined) {
    return {
      dispatch: {
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
  const decisionCeiling = decisionToTraceContentCeiling(parentTraceContext?.decision);
  const ceiling =
    decisionCeiling === undefined
      ? forwardedTracePolicy?.ceiling
      : forwardedTracePolicy === undefined
        ? decisionCeiling
        : {
            recordInputs: decisionCeiling.recordInputs && forwardedTracePolicy.ceiling.recordInputs,
            recordOutputs:
              decisionCeiling.recordOutputs && forwardedTracePolicy.ceiling.recordOutputs,
          };

  return {
    dispatch: {
      originAudience: forwardedTracePolicy?.originAudience ?? liveAudience,
      parentTraceContext: callerTraceContext === undefined ? undefined : parentTraceContext,
      traceSeed: allocateChildSessionTraceSeed({
        callId: input.invocation.callId,
        forwardedTracePolicy:
          ceiling === undefined
            ? undefined
            : {
                ceiling,
                originAudience: forwardedTracePolicy?.originAudience ?? liveAudience ?? "unknown",
              },
        sessionId: input.sessionId,
        turnId: input.turnId,
      }),
    },
    serializedContext,
  };
}

export function acknowledgeAgentInvocationTrace(input: {
  readonly callId: string;
  readonly childTraceId: string | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly turnId: string;
}): Record<string, unknown> {
  return input.childTraceId === undefined
    ? input.serializedContext
    : recordActionChildTraceId(
        input.serializedContext,
        input.sessionId,
        input.turnId,
        input.callId,
        input.childTraceId,
      );
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
