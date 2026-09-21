import { sortSessions, type SessionHistory } from "./session-history.ts";

export function mergeSessionHistory(
  current: SessionHistory | undefined,
  incoming: SessionHistory,
): SessionHistory {
  if (!current || current.viewer.id !== incoming.viewer.id) return incoming;
  const sessions = new Map(current.sessions.map((session) => [session.id, session]));
  for (const session of incoming.sessions) {
    const live = sessions.get(session.id);
    sessions.set(session.id, {
      ...session,
      lastMessageAt: latest(session.lastMessageAt, live?.lastMessageAt),
      lastTurnAt: latest(session.lastTurnAt, live?.lastTurnAt),
    });
  }
  // Refresh starts pagination at the first page again. De-duplication retains loaded
  // rows while allowing moved/new rows to be discovered without a stale cursor gap.
  return { ...incoming, sessions: sortSessions([...sessions.values()]) };
}
function latest(a?: string, b?: string) {
  return !a ? b : !b ? a : Date.parse(a) > Date.parse(b) ? a : b;
}
