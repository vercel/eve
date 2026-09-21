import type { ClientSessionState, MessageStreamEvent } from "eve/client";

export interface SavedChatSession {
  readonly events: readonly MessageStreamEvent[];
  readonly session: ClientSessionState;
}

export function createChatSessionCache(limit = 8) {
  const sessions = new Map<string, SavedChatSession>();
  const requests = new Map<string, Promise<SavedChatSession>>();
  let generation = 0;
  const cache = {
    clear() {
      generation++;
      sessions.clear();
      requests.clear();
    },
    get(id: string): SavedChatSession | undefined {
      return sessions.get(id);
    },
    set(snapshot: SavedChatSession) {
      const id = snapshot.session.sessionId;
      sessions.delete(id);
      // Large histories still resume from the durable stream without retaining them in memory.
      if (snapshot.events.length > 10_000) return;
      sessions.set(id, snapshot);
      while (sessions.size > limit) sessions.delete(sessions.keys().next().value!);
    },
    load(id: string, read: () => Promise<SavedChatSession>): Promise<SavedChatSession> {
      const saved = cache.get(id);
      if (saved) return Promise.resolve(saved);
      const pending = requests.get(id);
      if (pending) return pending;
      const version = generation;
      const request = read()
        .then((snapshot) => {
          if (version !== generation) throw new Error("Session identity changed.");
          // A live stream may have advanced while the snapshot was being fetched.
          const latest = cache.get(id);
          if (latest && latest.session.streamIndex >= snapshot.session.streamIndex) return latest;
          cache.set(snapshot);
          return snapshot;
        })
        .finally(() => {
          if (requests.get(id) === request) requests.delete(id);
        });
      requests.set(id, request);
      return request;
    },
  };
  return cache;
}
