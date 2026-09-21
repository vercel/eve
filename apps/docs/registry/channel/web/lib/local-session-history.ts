import type { MessageStreamEvent } from "eve/client";
import {
  applySessionActivity,
  sortSessions,
  type ChatSession,
  type SessionHistory,
} from "./session-history.ts";

type LocalSession = ChatSession & { titleAt?: string };
const key = "eve:web:local-sessions:v1";
/** This browser remembers only IDs it already possesses; no server-wide enumeration. */
export function createLocalSessionHistory(storage: Pick<Storage, "getItem" | "setItem">) {
  let sessions: LocalSession[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const snapshot = (): SessionHistory => ({
    sessions: sortSessions(sessions),
    viewer: { id: "local", name: "Local workspace", source: "local" },
  });
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    try {
      storage.setItem(key, JSON.stringify(sessions));
    } catch {
      /* Memory remains usable. */
    }
  };
  return {
    load() {
      if (timer) return snapshot();
      try {
        const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
        if (Array.isArray(value))
          sessions = value
            .filter(
              (s): s is LocalSession =>
                typeof s?.id === "string" &&
                /^wrun_[A-Za-z0-9]+$/.test(s.id) &&
                typeof s.title === "string" &&
                Number.isFinite(Date.parse(s.createdAt)),
            )
            .slice(0, 500);
      } catch {
        /* Keep this page's history when storage is unavailable. */
      }
      return snapshot();
    },
    record(id: string, event: MessageStreamEvent) {
      const at = event.meta.at;
      if (!Number.isFinite(Date.parse(at))) return snapshot();
      let session = sessions.find((s) => s.id === id);
      if (!session) session = { id, title: "New chat", createdAt: at };
      session = {
        ...session,
        ...applySessionActivity(session, event),
        createdAt: at < session.createdAt ? at : session.createdAt,
      };
      if (
        event.type === "message.received" &&
        event.data.kind !== "execution.background_task" &&
        (!session.titleAt || at < session.titleAt)
      ) {
        session = {
          ...session,
          title: event.data.message.trim().replace(/\s+/g, " ").slice(0, 160) || "New chat",
          titleAt: at,
        };
      }
      sessions = sortSessions([session, ...sessions.filter((s) => s.id !== id)]).slice(0, 500);
      if (!timer) timer = setTimeout(flush, 250);
      return snapshot();
    },
    flush,
  };
}
