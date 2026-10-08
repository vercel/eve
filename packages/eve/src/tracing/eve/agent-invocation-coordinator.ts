import type { SessionTraceContext } from "#channel/types.js";
import { ConversationIdKey } from "#context/keys.js";
import { readConversationId } from "#shared/conversation-identity.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { ConversationContext } from "#shared/conversation-context.js";
import {
  applyLiveDeliveryAudienceCeiling,
  readForwardedTraceAssertion,
} from "#shared/forwarded-trace-policy.js";
import {
  readActionTraceContext,
  readTurnTraceContext,
} from "#tracing/agent-trace-context-store.js";

export interface AgentChildTraceDispatch {
  readonly conversationId?: string;
  readonly originAudience: ChannelAudience;
  readonly parentTraceContext?: SessionTraceContext;
}

/**
 * The trace dispatch for sessions opened with `ctx.agent` while a run serves
 * one workflow tool call: the call's tool span in the calling turn, read from
 * the calling session when it admits the call.
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
