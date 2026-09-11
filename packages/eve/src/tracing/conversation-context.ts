import { contextStorage } from "#context/container.js";
import { ConversationIdKey } from "#context/keys.js";
import { readBaggageMember, replaceBaggageMember } from "#protocol/baggage.js";

const BAGGAGE_KEY = "eve.conversation.id";
const MAX_ID_BYTES = 1024;
const encoder = new TextEncoder();

export function readConversationId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_BYTES ||
    // oxlint-disable-next-line no-control-regex -- Indexed correlation IDs must not contain controls or line separators.
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ||
    encoder.encode(value).byteLength > MAX_ID_BYTES
  )
    return undefined;
  try {
    encodeURIComponent(value);
    return value;
  } catch {
    return undefined;
  }
}

export function resolveConversationId(fallback: string): string {
  return readConversationId(contextStorage.getStore()?.get(ConversationIdKey)) ?? fallback;
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
