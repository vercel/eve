import { createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";
import { readBaggageMember, replaceBaggageMember } from "#protocol/baggage.js";
import { readConversationId } from "#shared/conversation-identity.js";

const BAGGAGE_KEY = "eve.conversation.id";
const CONVERSATION_KEY = createContextKey("eve.trace.conversation.id");

export function withConversationId(context: Context, conversationId: string): Context {
  return context.setValue(CONVERSATION_KEY, conversationId);
}

export function conversationIdFromContext(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const getValue = Reflect.get(context, "getValue");
  return typeof getValue === "function"
    ? readConversationId(Reflect.apply(getValue, context, [CONVERSATION_KEY]))
    : undefined;
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
