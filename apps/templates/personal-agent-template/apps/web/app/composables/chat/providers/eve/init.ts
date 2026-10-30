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
    for (const event of options?.initialEvents ?? []) recordAuthorizationEvent(event);
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
      () => [created.events.value, created.session.value, created.status.value] as const,
      () => {
        if (created.status.value === "resuming") return;
        const events = created.events.value;
        const tail = events.at(-1);
        if (created.status.value !== "idle") {
          let boundary = false;
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index]!;
            if (event.meta.position.line !== tail?.meta.position.line) break;
            if (
              ["turn.paused", "response.admitted", "delivery.settled", "session.ended"].includes(
                event.type,
              )
            ) {
              boundary = true;
              break;
            }
          }
          if (!boundary) return;
        }
        const snapshot = { events, session: created.session.value };
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
    agent.newSession();
  }
  agentsByChatId.clear();
}
