import { createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";
import { readBaggageMember, replaceBaggageMember } from "#protocol/baggage.js";
import { readConversationId, resolveConversationId } from "#shared/conversation-identity.js";

const BAGGAGE_KEY = "eve.conversation.id";
const CONVERSATION_KEY = createContextKey("eve.trace.conversation.id");
const TRACE_SESSION_KEY = createContextKey("eve.trace.session.id");

export function withConversationId(context: Context, conversationId: string): Context {
  return context.setValue(CONVERSATION_KEY, conversationId);
}

interface OperationConversation {
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly traceSessionId?: string;
}

export function traceSessionIdOf(scope: OperationConversation): string {
  return scope.traceSessionId ?? scope.rootSessionId ?? scope.sessionId;
}

export function operationConversationId(input: OperationConversation): string {
  return resolveConversationId(input.rootSessionId ?? input.sessionId);
}

export function withOperationTraceContext(context: Context, input: OperationConversation): Context {
  return withConversationId(context, operationConversationId(input)).setValue(
    TRACE_SESSION_KEY,
    traceSessionIdOf(input),
  );
}

export function conversationIdFromContext(context: unknown): string | undefined {
  return readConversationId(readContextValue(context, CONVERSATION_KEY));
}

export function traceSessionIdFromContext(context: unknown): string | undefined {
  const value = readContextValue(context, TRACE_SESSION_KEY);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readContextValue(context: unknown, key: symbol): unknown {
  if (typeof context !== "object" || context === null) return undefined;
  const getValue = Reflect.get(context, "getValue");
  if (typeof getValue !== "function") return undefined;
  return Reflect.apply(getValue, context, [key]);
}

export function readConversationBaggage(value: string | null): string | undefined {
  const member = readBaggageMember(value, BAGGAGE_KEY);
  return typeof member === "string" ? undefined : readConversationId(member.value);
}

export function writeConversationBaggage(
  value: string | undefined,
  conversationId: string | undefined,
): string | undefined {
  const id = readConversationId(conversationId);
  return id === undefined
    ? value
    : replaceBaggageMember(value, BAGGAGE_KEY, encodeURIComponent(id));
}
