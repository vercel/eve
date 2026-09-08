import { resolveConversationId } from "#tracing/conversation-context.js";
import { AGENT_TRACE_SCHEMA_VERSION } from "#tracing/agent-span-contract.js";

export function agentTraceIdentityAttributes(input: {
  readonly rootSessionId: string;
  readonly sessionId: string;
}): Record<string, string | number> {
  return {
    "agent.trace.schema.version": AGENT_TRACE_SCHEMA_VERSION,
    "agent.session.id": input.sessionId,
    "vercel.session_id": input.sessionId,
    "gen_ai.conversation.id": resolveConversationId(input.rootSessionId),
  };
}
