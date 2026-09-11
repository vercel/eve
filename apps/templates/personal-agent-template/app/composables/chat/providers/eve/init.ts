import type { EveMessageData, UseEveAgentReturn } from "eve/vue";
import type { ChatSessionOptions } from "~/composables/chat/types";
import { recordAuthorizationEvent } from "~/composables/chat/useAuthorizationChallenges";
import { persistThreadState } from "./thread-state";
import { recordStreamEvent } from "./stream-log";

const agentsByChatId = new Map<string, UseEveAgentReturn<EveMessageData>>();

export function getOrCreateEveAgent(chatId: string, options?: ChatSessionOptions) {
  let agent = agentsByChatId.get(chatId);
  if (!agent) {
    agent = useEveAgent({
      initialSession: options?.initialSession,
      initialEvents: options?.initialEvents,
      onFinish: (snapshot) => {
        void persistThreadState(chatId, snapshot);
      },
      onEvent: (event) => {
        if (event.type === "authorization.required" || event.type === "authorization.completed") {
          recordAuthorizationEvent(event);
        }

        if (!import.meta.dev) return;
        recordStreamEvent(event.type);
      },
    });
    agentsByChatId.set(chatId, agent);
  }
  return agent;
}

export function removeEveAgent(chatId: string) {
  agentsByChatId.delete(chatId);
}

export function resetAllEveAgents() {
  for (const agent of agentsByChatId.values()) {
    agent.reset();
  }
  agentsByChatId.clear();
}
