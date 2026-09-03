import { resolveConversationId } from "#tracing/conversation-context.js";

export const AGENT_INVOCATION_ROLES = {
  caller: "caller",
} as const;

export const AGENT_TRACE_ATTRIBUTES = {
  invocationRole: "agent.invocation.role",
  sessionId: "agent.session.id",
  vercelSessionId: "vercel.session_id",
} as const;

export function agentTraceIdentityAttributes(input: {
  readonly rootSessionId: string;
  readonly sessionId: string;
}): Record<string, string> {
  return {
    [AGENT_TRACE_ATTRIBUTES.sessionId]: input.sessionId,
    [AGENT_TRACE_ATTRIBUTES.vercelSessionId]: input.sessionId,
    "gen_ai.conversation.id": resolveConversationId(input.rootSessionId),
  };
}
