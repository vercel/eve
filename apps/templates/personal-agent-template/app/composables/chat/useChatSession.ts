import type { MaybeRefOrGetter } from "vue";
import type { ChatSession, ChatSessionOptions } from "~/composables/chat/types";
import { createEveChatSession } from "~/composables/chat/providers/eve/session";

export function useChatSession(
  chatId: MaybeRefOrGetter<string> = "default",
  options?: MaybeRefOrGetter<ChatSessionOptions | undefined>,
): ChatSession {
  return createEveChatSession(chatId, options);
}
