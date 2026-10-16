import { watch } from "vue";
import { type UseEveAgentReturn, useEveAgent } from "eve/vue";
import type { ChatSessionOptions } from "~/composables/chat/types";
import { recordAuthorizationEvent } from "~/composables/chat/useAuthorizationChallenges";
import { persistThreadState } from "./thread-state";
import { recordStreamEvent, resetTurnEventCounts } from "./stream-log";

const agentsByChatId = new Map<string, UseEveAgentReturn>();

export function getOrCreateEveAgent(chatId: string, options?: ChatSessionOptions) {
  let agent = agentsByChatId.get(chatId);
  if (!agent) {
    agent = useEveAgent({
      initialSession: options?.initialSession,
      initialEvents: options?.initialEvents,
      onEvent: (event) => {
        if (event.type === "interaction.opened" || event.type === "interaction.settled") {
          recordAuthorizationEvent(event);
        }

        if (!import.meta.dev) return;
        if (event.type === "turn.started") resetTurnEventCounts();
        recordStreamEvent(event.type);
      },
    });
    const created = agent;
    let persistence = Promise.resolve();
    // Acceptance is not completion. Save committed idle/person-waiting/catch-up states, including
    // admitted answers, in order rather than relying on the live turn's onFinish callback.
    watch(
      () => [created.events.value, created.session.value] as const,
      () => {
        const snapshot = { events: created.events.value, session: created.session.value };
        persistence = persistence.catch(() => {}).then(() => persistThreadState(chatId, snapshot));
        void persistence.catch(() => {});
      },
      { flush: "post" },
    );
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
