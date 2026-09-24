import type { SessionTraceContext } from "#channel/types.js";
import { ConversationIdKey } from "#context/keys.js";
import { readConversationId } from "#tracing/conversation-context.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type { SessionStateMap } from "#harness/types.js";
import { getTaskTable } from "#tasks/state.js";
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
  const parentActionCallId = getTaskTable({ state: input.sessionState }).records.find(
    (record) => record.child?.kind === "workflow" && record.child.runId === input.ownerId,
  )?.callId;
  const turnId = input.turnId;
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
  const storedParentTraceContext = callerTraceContext ?? outerTrace;
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
            environment,
          ),
        };
  return {
    dispatch: {
      conversationId,
      originAudience: forwardedTracePolicy?.originAudience ?? liveAudience,
      parentTraceContext,
    },
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
