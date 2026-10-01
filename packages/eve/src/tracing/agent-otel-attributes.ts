import { resolveConversationId } from "#shared/conversation-identity.js";
import { contextStorage } from "#context/container.js";
import { TraceRootKey } from "#context/keys.js";
import { resolveTraceRootSessionId } from "#shared/trace-root.js";
import { AGENT_TRACE_SCHEMA_VERSION } from "#tracing/agent-span-contract.js";

export function agentTraceIdentityAttributes(input: {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly traceSessionId?: string;
}): Record<string, string | number> {
  const conversationId = resolveConversationId(input.rootSessionId);
  const attributes: Record<string, string | number> = {
    "agent.run.id": input.sessionId,
    "agent.trace.schema.version": AGENT_TRACE_SCHEMA_VERSION,
    "gen_ai.conversation.id": conversationId,
  };
  if (process.env.VERCEL_ENV !== undefined) {
    const ctx = contextStorage.getStore();
    const traceSessionId =
      input.traceSessionId ??
      (ctx?.get(TraceRootKey) === undefined
        ? input.rootSessionId
        : resolveTraceRootSessionId(ctx, input.sessionId));
    attributes["vercel.session_id"] = traceSessionId;
  }
  return attributes;
}
