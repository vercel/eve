import type { MaybeRefOrGetter } from "vue";
import { nextTick, toValue } from "vue";
import type { ThreadRecord, ThreadSummary } from "#shared/types/thread";
import { resetAllEveAgents, removeEveAgent } from "~/composables/chat/providers/eve/init";
import { resetStreamLog } from "~/composables/chat/providers/eve/stream-log";
import { truncateThreadTitle } from "#shared/types/thread";
import { clearCachedPayloadData } from "~/utils/payload-cache";

type PendingMessage = {
  chatId: string;
  text: string;
};

let pendingMessage: PendingMessage | null = null;

const CHAT_PATH = /^\/chat\/[^/]+$/;

function isHomeChatTransition(from: string, to: string) {
  return (from === "/" && CHAT_PATH.test(to)) || (CHAT_PATH.test(from) && to === "/");
}

async function navigateWithChatPromptTransition(to: string) {
  if (!import.meta.client || !document.startViewTransition) {
    return navigateTo(to);
  }

  const route = useRoute();
  if (!isHomeChatTransition(route.path, to)) {
    return navigateTo(to);
  }

  const transition = document.startViewTransition(async () => {
    await navigateTo(to);
    await nextTick();
  });

  await transition.finished;
}

export const THREAD_LIST_KEY = "thread-list";

interface ThreadListResponse {
  threads: ThreadSummary[];
}

function upsertThreadInListCache(thread: ThreadSummary) {
  if (!import.meta.client) {
    return;
  }

  const nuxtApp = useNuxtApp();
  const cached = nuxtApp.payload.data[THREAD_LIST_KEY] as ThreadListResponse | undefined;
  const threads = cached?.threads ?? [];
  nuxtApp.payload.data[THREAD_LIST_KEY] = {
    threads: [thread, ...threads.filter((entry) => entry.id !== thread.id)],
  };
}

export async function refreshThreadList() {
  clearCachedPayloadData(THREAD_LIST_KEY);
  await refreshNuxtData(THREAD_LIST_KEY);
}

export async function startChat(message: string, chatId = crypto.randomUUID()) {
  const text = message.trim();
  if (!text) return;

  const { thread } = await $fetch<{ thread: ThreadRecord }>("/api/threads", {
    method: "POST",
    body: {
      id: chatId,
      title: truncateThreadTitle(text),
    },
  });

  upsertThreadInListCache(thread);
  pendingMessage = { chatId, text };
  await refreshThreadList();
  await navigateWithChatPromptTransition(`/chat/${chatId}`);
}

export function consumePendingMessage(chatId: string) {
  if (pendingMessage?.chatId !== chatId) return null;

  const text = pendingMessage.text;
  pendingMessage = null;
  return text;
}

export async function startNewChat() {
  pendingMessage = null;
  resetStreamLog();
  resetAllEveAgents();
  await navigateWithChatPromptTransition("/");
}

export function useChatNavigation(chatId: MaybeRefOrGetter<string>) {
  function consumePendingOnMount(sendMessage: (text: string) => Promise<void>) {
    const id = toValue(chatId);
    const pending = consumePendingMessage(id);
    if (pending) {
      void sendMessage(pending);
      return true;
    }
    return false;
  }

  return {
    consumePendingOnMount,
  };
}

export async function deleteThread(id: string) {
  await $fetch(`/api/threads/${id}`, { method: "DELETE" });
  removeEveAgent(id);
  await refreshThreadList();

  const route = useRoute();
  if (route.params.id === id) {
    await startNewChat();
  }
}
