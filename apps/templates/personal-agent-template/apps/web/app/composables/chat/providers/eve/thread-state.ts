import type { UseEveAgentSnapshot } from "eve/vue";
import type { ThreadRecord, ThreadState } from "#eve/types/thread";
import type { ChatSessionOptions, EveStreamEvent } from "~/composables/chat/types";
import { refreshThreadList } from "~/composables/chat/navigation";

export function resumeOptionsFromThread(thread: ThreadRecord): ChatSessionOptions {
  const events = thread.state?.events;
  if (!events?.length) {
    return {};
  }

  const session = thread.state?.session;

  return {
    initialSession: session?.sessionId
      ? {
          sessionId: session.sessionId,
          streamIndex: session.streamIndex ?? 0,
        }
      : undefined,
    initialEvents: events as readonly EveStreamEvent[],
  };
}

export async function persistThreadState(
  threadId: string,
  snapshot: Pick<UseEveAgentSnapshot, "events" | "session">,
) {
  if (!snapshot.events.length || !snapshot.session) {
    return;
  }

  const state: ThreadState = {
    session: {
      sessionId: snapshot.session.sessionId,
      streamIndex: snapshot.session.streamIndex,
    },
    events: [...snapshot.events],
  };

  await $fetch(`/api/threads/${threadId}`, {
    method: "PATCH",
    body: { state },
  });

  void refreshThreadList();
}
