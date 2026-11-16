import type { ConversationState } from "eve/vue";
import type { MaybeRefOrGetter } from "vue";
import { computed, toValue } from "vue";
import type { AgentInputResponse } from "~/components/AgentInputRequest.vue";
import type { ChatSession, ChatSessionOptions } from "~/composables/chat/types";
import { toUIMessages } from "./adapter";
import { getOrCreateEveAgent } from "./init";

function lastUserMessageText(data: Pick<ConversationState, "messages">) {
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

function isSessionGone(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "session_stranded" || code === "session_expired" || code === "session_not_active";
}

export function createEveChatSession(
  chatId: MaybeRefOrGetter<string>,
  options?: MaybeRefOrGetter<ChatSessionOptions | undefined>,
): ChatSession {
  const id = computed(() => toValue(chatId));
  const resolvedOptions = computed(() => toValue(options));
  const binding = computed(() => getOrCreateEveAgent(id.value, resolvedOptions.value));
  const agent = computed(() => binding.value.agent);
  const historyMessages = computed(() => binding.value.historyMessages.value);
  const messages = computed(() => [
    ...historyMessages.value,
    ...toUIMessages(agent.value.messages.value),
  ]);

  const status = computed(() =>
    binding.value.busy.value
      ? "streaming"
      : agent.value.error.value !== undefined
        ? "error"
        : agent.value.status.value === "idle"
          ? "ready"
          : "streaming",
  );
  const error = computed(() => agent.value.error.value);

  const isBusy = computed(() => status.value === "streaming");

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    await deliver(trimmed);
  }

  async function deliver(text: string) {
    const current = binding.value;
    if (current.busy.value) return;
    current.busy.value = true;
    let generation = current.generation;
    try {
      try {
        await current.agent.send(text);
      } catch (error) {
        if (generation !== current.generation) return;
        // Only definitive rejection is safe to resend; a network failure may have been accepted.
        if (!isSessionGone(error)) {
          current.indeterminate = true;
          throw error;
        }
        if (!(await current.restart())) return;
        generation = current.generation;
        try {
          await current.agent.send(text);
        } catch (replacementError) {
          if (generation === current.generation && !isSessionGone(replacementError))
            current.indeterminate = true;
          throw replacementError;
        }
      }
    } finally {
      current.busy.value = false;
    }
  }

  async function sendInputResponses(responses: AgentInputResponse[]) {
    await agent.value.respond(responses);
  }

  function stop() {
    void agent.value.cancel();
  }

  function reset() {
    binding.value.reset();
  }

  async function retry() {
    if (isBusy.value) return;

    const current = binding.value;
    // Idle only describes the observed stream. A failed POST can still have been accepted.
    // Catch-up cannot prove non-delivery, so repeated retries remain reconnect-only.
    if (
      current.indeterminate ||
      (current.agent.status.value === "busy" && !isSessionGone(current.agent.error.value))
    ) {
      current.busy.value = true;
      try {
        await current.agent.resume();
      } finally {
        current.busy.value = false;
      }
      return;
    }

    const text = lastUserMessageText({ messages: agent.value.messages.value });
    if (!text) return;

    await deliver(text);
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
