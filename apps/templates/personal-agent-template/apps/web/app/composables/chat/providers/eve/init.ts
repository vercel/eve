import { shallowRef, watch } from "vue";
import type { ShallowRef } from "vue";
import type { ThreadState } from "#eve/types/thread";
import { type EveMessage, type UseEveAgentReturn, useEveAgent } from "eve/vue";
import type { UIMessage } from "ai";
import type { ChatSessionOptions, EveStreamEvent } from "~/composables/chat/types";
import { toUIMessages } from "./adapter";
import {
  clearAuthorizationChallenges,
  recordAuthorizationEvent,
} from "~/composables/chat/useAuthorizationChallenges";
import { persistThreadState } from "./thread-state";
import { recordStreamEvent, resetTurnEventCounts } from "./stream-log";

type ChatBinding = {
  agent: UseEveAgentReturn;
  historyMessages: ShallowRef<UIMessage[]>;
  restart: () => Promise<void>;
};
const agentsByChatId = new Map<string, ChatBinding>();
let activeChatId: string | undefined;

function retiredMessages(sessionId: string, messages: readonly EveMessage[]) {
  return toUIMessages(messages).map((message) => ({
    ...message,
    id: `${sessionId}:${message.id}`,
    metadata: { retired: true },
  }));
}

export function getOrCreateEveAgent(chatId: string, options?: ChatSessionOptions) {
  let binding = agentsByChatId.get(chatId);
  if (activeChatId !== chatId) {
    activeChatId = chatId;
    clearAuthorizationChallenges();
    for (const event of binding?.agent.events.value ?? options?.initialEvents ?? [])
      recordAuthorizationEvent(event);
  }
  if (!binding) {
    const history = shallowRef<NonNullable<ThreadState["history"]>>(options?.history ?? []);
    const historyMessages = shallowRef(
      history.value.flatMap((snapshot) => {
        // Project each retired stream independently, without binding or following its session.
        const archived = useEveAgent({
          initialEvents: snapshot.events as EveStreamEvent[],
          followWhile: () => false,
        });
        return retiredMessages(snapshot.session.sessionId, archived.messages.value);
      }),
    );
    const agent = useEveAgent({
      initialSession: options?.initialSession,
      initialEvents: options?.initialEvents,
      onEvent: (event) => {
        if (activeChatId === chatId) recordAuthorizationEvent(event);

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
        const archived = history.value;
        persistence = persistence
          .catch(() => {})
          .then(() => persistThreadState(chatId, snapshot, archived));
        void persistence.catch(() => {});
      },
      { flush: "post" },
    );
    binding = {
      agent,
      historyMessages,
      async restart() {
        const session = agent.session.value;
        const events = [...agent.events.value];
        if (session && events.length) {
          // Finish pending writes before retiring the binding; a failed save must not erase it.
          persistence = persistence
            .catch(() => {})
            .then(() => persistThreadState(chatId, { session, events }, history.value));
          await persistence;
          history.value = [...history.value, { session: { ...session }, events }];
          historyMessages.value = [
            ...historyMessages.value,
            ...retiredMessages(session.sessionId, agent.messages.value),
          ];
        }
        agent.newSession();
        if (activeChatId === chatId) clearAuthorizationChallenges();
      },
    };
    agentsByChatId.set(chatId, binding);
  }
  return binding;
}

export function removeEveAgent(chatId: string) {
  agentsByChatId.delete(chatId);
}

export function resetAllEveAgents() {
  for (const { agent } of agentsByChatId.values()) {
    agent.newSession();
  }
  agentsByChatId.clear();
  activeChatId = undefined;
  clearAuthorizationChallenges();
}
