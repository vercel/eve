import type { SessionTraceContext } from "#channel/types.js";
import { ConversationIdKey } from "#context/keys.js";
import { readConversationId } from "#shared/conversation-identity.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type { SessionStateMap } from "#harness/types.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { type ChannelAudience } from "#shared/channel-audience.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import {
  applyLiveDeliveryAudienceCeiling,
  readForwardedTraceAssertion,
} from "#shared/forwarded-trace-policy.js";
import { deriveAgentActionSpanId } from "#tracing/agent-span-id-generator.js";
import {
  readActionTraceContext,
  readTurnTraceContext,
  recordActionInvocationKind,
  recordNestedAgentInvocation,
} from "#tracing/agent-trace-context-store.js";
import {
  invocationError,
  recordNestedAgentInvocationTerminal,
} from "#tracing/agent-invocation-terminal.js";

export interface AgentChildTraceDispatch {
  readonly conversationId?: string;
  readonly originAudience: ChannelAudience;
  readonly parentTraceContext?: SessionTraceContext;
}

export function prepareAgentInvocationTrace(input: {
  readonly conversation?: ConversationContext;
  readonly invocation: {
    readonly callId: string;
    readonly kind: "remote-agent-call" | "subagent-call";
    readonly name: string;
  };
  readonly ownerId: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState?: SessionStateMap;
  readonly startTimeMs: number;
  readonly turnId: string;
}): {
  readonly dispatch: AgentChildTraceDispatch;
  fail(result: RuntimeSubagentResult): Record<string, unknown>;
  readonly serializedContext: Record<string, unknown>;
} {
  const conversationId = readConversationId(input.serializedContext[ConversationIdKey.name]);
  const parentActionCallId = getBlockingWorkflowToolRuns(input.sessionState).find(
    (run) => run.address.runId === input.ownerId,
  )?.callId;
  const { turnId } = input;
  const parentTurnContext = readTurnTraceContext(input.serializedContext, input.sessionId, turnId);
  const conversation = input.conversation;
  const liveAudience = conversation?.audience ?? "unknown";
  const environment = conversation?.environment ?? "production";
  const outerTrace =
    (parentActionCallId === undefined
      ? undefined
      : readActionTraceContext(
          input.serializedContext,
          input.sessionId,
          turnId,
          parentActionCallId,
        )) ?? parentTurnContext;
  const outputDecision =
    outerTrace?.decision === undefined
      ? undefined
      : applyLiveDeliveryAudienceCeiling(
          outerTrace.decision,
          liveAudience,
          outerTrace.forwardedTracePolicy,
          environment,
        );
  const serializedContext =
    parentActionCallId === undefined
      ? input.serializedContext
      : parentActionCallId === input.invocation.callId
        ? recordActionInvocationKind({
            callId: input.invocation.callId,
            kind: input.invocation.kind,
            serializedContext: input.serializedContext,
            sessionId: input.sessionId,
            turnId,
          })
        : recordNestedAgentInvocation({
            callId: input.invocation.callId,
            kind: input.invocation.kind,
            name: input.invocation.name,
            outerCallId: parentActionCallId,
            recordOutputs: outputDecision?.action === "record" && outputDecision.recordOutputs,
            serializedContext: input.serializedContext,
            sessionId: input.sessionId,
            spanId: deriveAgentActionSpanId(input.sessionId, turnId, input.invocation.callId),
            startTimeMs: input.startTimeMs,
            turnId,
          });
  const callerTraceContext = readActionTraceContext(
    serializedContext,
    input.sessionId,
    turnId,
    input.invocation.callId,
  );
  return {
    dispatch: toChildTraceDispatch({
      conversation,
      conversationId,
      stored: callerTraceContext ?? outerTrace,
    }),
    fail: (result) =>
      recordNestedAgentInvocationTerminal({
        callId: input.invocation.callId,
        serializedContext,
        sessionId: input.sessionId,
        terminal: {
          acceptedAtMs: Date.now(),
          error: invocationError(result.output),
          outcome: "failed",
        },
        turnId,
      }),
    serializedContext,
  };
}

/**
 * The trace dispatch for sessions a workflow tool call's run opens with
 * `ctx.agent`, read from the calling session when the run starts.
 */
export function resolveToolCallAgentTrace(input: {
  readonly callId: string;
  readonly conversation?: ConversationContext;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly turnId: string;
}): AgentChildTraceDispatch {
  const { serializedContext, sessionId, turnId } = input;
  return toChildTraceDispatch({
    conversation: input.conversation,
    conversationId: readConversationId(serializedContext[ConversationIdKey.name]),
    stored:
      readActionTraceContext(serializedContext, sessionId, turnId, input.callId) ??
      readTurnTraceContext(serializedContext, sessionId, turnId),
  });
}

/** Caps a stored parent trace context to the live delivery audience. */
function toChildTraceDispatch(input: {
  readonly conversation?: ConversationContext;
  readonly conversationId?: string;
  readonly stored?: SessionTraceContext;
}): AgentChildTraceDispatch {
  const { stored } = input;
  const liveAudience = input.conversation?.audience ?? "unknown";
  const environment = input.conversation?.environment ?? "production";
  const forwardedTracePolicy = readForwardedTraceAssertion(stored?.forwardedTracePolicy);
  const parentTraceContext =
    stored?.decision === undefined
      ? stored
      : {
          ...stored,
          decision: applyLiveDeliveryAudienceCeiling(
            stored.decision,
            liveAudience,
            forwardedTracePolicy,
            environment,
          ),
        };
  return {
    conversationId: input.conversationId,
    originAudience: forwardedTracePolicy?.originAudience ?? liveAudience,
    parentTraceContext,
  };
}
