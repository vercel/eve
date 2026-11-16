import type { UseEveAgentSnapshot } from "eve/vue";
import type { EveSessionCursor, ThreadRecord, ThreadState } from "#eve/types/thread";
import type { ChatSessionOptions, EveStreamEvent } from "~/composables/chat/types";
import { refreshThreadList } from "~/composables/chat/navigation";

export function resumeOptionsFromThread(thread: ThreadRecord): ChatSessionOptions {
  const events = thread.state?.events;
  if (!events?.length) {
    return {};
  }

  const session = thread.state?.session;
  let initialSession: EveSessionCursor | undefined;
  if (session?.sessionId) {
    initialSession = { sessionId: session.sessionId, streamIndex: session.streamIndex ?? 0 };
    if (session.inbox) initialSession.inbox = session.inbox;
  }

  return {
    initialSession,
    initialEvents: events as readonly EveStreamEvent[],
    history: thread.state?.history,
  };
}

export async function persistThreadState(
  threadId: string,
  snapshot: Pick<UseEveAgentSnapshot, "events" | "session">,
  history?: ThreadState["history"],
) {
  if (!snapshot.events.length || !snapshot.session) {
    return;
  }

  // Save eve's whole session state, including the opaque `inbox` handle that lets later sends
  // skip a server-side session lookup.
  const session: EveSessionCursor = {
    sessionId: snapshot.session.sessionId,
    streamIndex: snapshot.session.streamIndex,
  };
  if (snapshot.session.inbox) session.inbox = snapshot.session.inbox;
  const state: ThreadState = { session, events: [...snapshot.events], history };

  await $fetch(`/api/threads/${threadId}`, {
    method: "PATCH",
    body: { state },
  });

  void refreshThreadList();
}
