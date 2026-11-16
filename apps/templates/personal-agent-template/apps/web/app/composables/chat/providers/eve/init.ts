import { effectScope, shallowRef, watch } from "vue";
import type { ShallowRef } from "vue";
import type { ThreadState } from "#eve/types/thread";
import { type UseEveAgentReturn, useEveAgent } from "eve/vue";
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
  busy: ShallowRef<boolean>;
  indeterminate: boolean;
  generation: number;
  reset: () => void;
  restart: () => Promise<boolean>;
};
const agentsByChatId = new Map<string, ChatBinding>();
let activeChatId: string | undefined;

function retiredMessages(sessionId: string, events: readonly EveStreamEvent[]) {
  // Project archives through the bundled Vue API without retaining a live binding or transport.
  const scope = effectScope();
  try {
    return scope.run(() =>
      toUIMessages(useEveAgent({ initialEvents: events }).messages.value).map((message) => ({
        ...message,
        id: `${sessionId}:${message.id}`,
        metadata: { retired: true },
      })),
    )!;
  } finally {
    scope.stop();
  }
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
      history.value.flatMap((snapshot) =>
        retiredMessages(snapshot.session.sessionId, snapshot.events as EveStreamEvent[]),
      ),
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
      busy: shallowRef(false),
      indeterminate: false,
      generation: 0,
      reset() {
        this.generation += 1;
        this.indeterminate = false;
        agent.newSession();
        if (activeChatId === chatId) clearAuthorizationChallenges();
      },
      async restart() {
        const generation = this.generation;
        const session = agent.session.value;
        const events = [...agent.events.value];
        if (session && events.length) {
          // Finish pending writes before retiring the binding; a failed save must not erase it.
          persistence = persistence
            .catch(() => {})
            .then(() => persistThreadState(chatId, { session, events }, history.value));
          await persistence;
          if (generation !== this.generation) return false;
          history.value = [...history.value, { session: { ...session }, events }];
          historyMessages.value = [
            ...historyMessages.value,
            ...retiredMessages(session.sessionId, events),
          ];
        }
        this.reset();
        return true;
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
  for (const binding of agentsByChatId.values()) {
    binding.reset();
  }
  agentsByChatId.clear();
  activeChatId = undefined;
  clearAuthorizationChallenges();
}
