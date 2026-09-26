import { readBaggageMember, replaceBaggageMember } from "#protocol/baggage.js";
import { readConversationId } from "#shared/conversation-identity.js";

const BAGGAGE_KEY = "eve.conversation.id";

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
