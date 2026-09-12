import { resolveConversationId } from "#tracing/conversation-context.js";
import { AGENT_TRACE_SCHEMA_VERSION } from "#tracing/agent-span-contract.js";

export function agentTraceIdentityAttributes(input: {
  readonly rootSessionId: string;
  readonly sessionId: string;
}): Record<string, string | number> {
  const rootSessionId = resolveConversationId(input.rootSessionId);
  return {
    "agent.run.id": input.sessionId,
    "agent.trace.schema.version": AGENT_TRACE_SCHEMA_VERSION,
    "gen_ai.conversation.id": rootSessionId,
    ...(process.env.VERCEL_ENV === undefined ? undefined : { "vercel.session_id": rootSessionId }),
  };
}
