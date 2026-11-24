import type {
  InboxItem,
  SessionStartInput,
  SessionStatus,
  StreamLine,
} from "#execution/durable.js";
import type { SessionRecord } from "#execution/session/record.js";
import type { SessionStore } from "#platform/engine.js";

import { createMemoryContentStore, type MemoryContentStore } from "./memory-content-store.js";

interface StoredSession {
  readonly start: SessionStartInput;
  record: SessionRecord | undefined;
  throughSeq: number;
  status: SessionStatus;
  readonly items: InboxItem[];
  readonly ids: Map<string, number>;
  readonly lines: string[];
  closed: boolean;
}

export interface MemorySessionStore extends SessionStore {
  readonly content: MemoryContentStore;
  saveRecordHook?: (sessionId: string) => Promise<void> | undefined;
}

export function createMemorySessionStore(): MemorySessionStore {
  const sessions = new Map<string, StoredSession>();
  const addresses = new Map<string, string>();
  const waiters = new Set<() => void>();
  const changed = (): Promise<void> => new Promise((resolve) => waiters.add(resolve));
  const notify = (): void => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const sessionOf = (sessionId: string): StoredSession => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error(`Session "${sessionId}" isn't in the store.`);
    return session;
  };
  const ended = (sessionId: string): boolean => {
    const status = sessions.get(sessionId)?.status;
    return status === "ended" || status === "failed";
  };

  const store: MemorySessionStore = {
    async begin(start) {
      if (sessions.has(start.sessionId)) return;
      sessions.set(start.sessionId, {
        closed: false,
        ids: new Map(),
        items: [],
        lines: [],
        record: undefined,
        start,
        status: "parked",
        throughSeq: 0,
      });
    },
    async claim(sessionId, claimed, takeOver) {
      for (const { key } of claimed) {
        const holder = addresses.get(key);
        if (holder !== undefined && holder !== sessionId && !takeOver && !ended(holder))
          return { claimed: false, heldBy: holder };
      }
      for (const { key } of claimed) addresses.set(key, sessionId);
      return { claimed: true };
    },
    async sessionFor({ key }) {
      return addresses.get(key);
    },
    async enqueue(sessionId, item) {
      const session = sessionOf(sessionId);
      const known = session.ids.get(item.id);
      if (known !== undefined) return known;
      const seq = session.items.length + 1;
      session.items.push({ ...item, seq });
      session.ids.set(item.id, seq);
      notify();
      return seq;
    },
    async itemsAfter(sessionId, seq, limit) {
      return sessionOf(sessionId).items.slice(seq, seq + limit);
    },
    async saveRecord(sessionId, record, throughSeq) {
      const hooked = store.saveRecordHook?.(sessionId);
      const session = sessionOf(sessionId);
      session.record = record;
      session.throughSeq = throughSeq;
      if (hooked !== undefined) await hooked;
    },
    async loadRun(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return undefined;
      return {
        start: session.start,
        throughSeq: session.throughSeq,
        ...(session.record !== undefined && { record: session.record }),
      };
    },
    async status(sessionId) {
      return sessions.get(sessionId)?.status;
    },
    async setStatus(sessionId, status) {
      sessionOf(sessionId).status = status;
      notify();
    },
    streams: {
      async append(sessionId, from, lines) {
        const session = sessionOf(sessionId);
        if (from !== session.lines.length)
          throw new Error(`Line ${from} isn't the next line of session "${sessionId}".`);
        session.lines.push(...lines);
        notify();
      },
      async close(sessionId) {
        sessionOf(sessionId).closed = true;
        notify();
      },
      async *read(sessionId, from): AsyncIterable<StreamLine> {
        const session = sessionOf(sessionId);
        let position = from < 0 ? Math.max(0, session.lines.length + from) : from;
        while (true) {
          const line = session.lines[position];
          if (line !== undefined) {
            yield { line, position };
            position += 1;
            continue;
          }
          if (session.closed) return;
          await changed();
        }
      },
      async tail(sessionId) {
        return sessionOf(sessionId).lines.length - 1;
      },
    },
    content: createMemoryContentStore(),
  };
  return store;
}
