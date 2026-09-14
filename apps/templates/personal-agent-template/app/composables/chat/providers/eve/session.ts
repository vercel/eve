import type { EveMessageData } from "eve/vue";
import type { MaybeRefOrGetter } from "vue";
import { computed, toValue } from "vue";
import type { AgentInputResponse } from "~/components/AgentInputRequest.vue";
import type { ChatSession, ChatSessionOptions } from "~/composables/chat/types";
import { toUIMessages } from "./adapter";
import { getOrCreateEveAgent } from "./init";

function lastUserMessageText(data: EveMessageData) {
  for (let index = data.messages.length - 1; index >= 0; index -= 1) {
    const message = data.messages[index];
    if (message?.role !== "user") continue;

    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (text) return text;
  }
}

export function createEveChatSession(
  chatId: MaybeRefOrGetter<string>,
  options?: MaybeRefOrGetter<ChatSessionOptions | undefined>,
): ChatSession {
  const id = computed(() => toValue(chatId));
  const resolvedOptions = computed(() => toValue(options));
  const agent = computed(() =>
    getOrCreateEveAgent(id.value, {
      initialSession: resolvedOptions.value?.initialSession,
      initialEvents: resolvedOptions.value?.initialEvents,
    }),
  );

  const messages = computed(() => toUIMessages(agent.value.data.value.messages));

  const status = computed(() =>
    agent.value.status.value === "resuming" ? "streaming" : agent.value.status.value,
  );
  const error = computed(() => agent.value.error.value);

  const isBusy = computed(() => status.value === "submitted" || status.value === "streaming");

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    await agent.value.send(trimmed);
  }

  async function sendInputResponses(responses: AgentInputResponse[]) {
    await agent.value.respond(responses);
  }

  function stop() {
    void agent.value.cancel();
  }

  function reset() {
    agent.value.reset();
  }

  async function retry() {
    if (isBusy.value) return;

    const text = lastUserMessageText(agent.value.data.value);
    if (!text) return;

    await agent.value.send(text);
  }

  return {
    messages,
    status,
    error,
    isBusy,
    sendMessage,
    sendInputResponses,
    stop,
    reset,
    retry,
  };
}
