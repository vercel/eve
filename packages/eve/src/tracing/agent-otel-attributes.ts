import { resolveConversationId } from "#shared/conversation-identity.js";
import { identityAttributes } from "#tracing/core/attributes.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";

export function traceSessionIdOf(scope: {
  readonly traceSessionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): string {
  return scope.traceSessionId ?? scope.rootSessionId ?? scope.sessionId;
}

export function agentTraceIdentityAttributes(input: {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly traceSessionId: string;
}): Record<string, string | number> {
  const conversationId = resolveConversationId(input.rootSessionId);
  return eveOutputMapping({
    resolve: () => ({
      platform: process.env.VERCEL_ENV === undefined ? "other" : "vercel",
      traceSessionId: input.traceSessionId,
    }),
  }).attributes(
    { type: "activation", operationId: input.sessionId },
    identityAttributes({
      conversationId,
      runId: input.sessionId,
      turnId: "",
    }),
  ) as Record<string, string | number>;
}
