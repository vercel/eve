import {
  readSubagentView,
  writeSubagentView,
  subagentViewKey,
  validCheckpoint,
  type SubagentStorage,
  type SubagentCheckpoint,
} from "./subagent-storage.ts";
import {
  initialSubagentProgress,
  reduceSubagentProgress,
  type SubagentProgress,
} from "./subagent-progress.ts";
import { Client } from "eve/client";
import { chatMessageReducer, type ChatMessageData } from "./chat-message-reducer.ts";
import {
  readSubagentEvents,
  subagentKey,
  subagentStreamPath,
  type SubagentSession,
} from "./subagent-session.ts";

interface PaneSnapshot {
  data: ChatMessageData;
  progress: SubagentProgress;
  status: string;
  error?: string;
  ready: boolean;
  disclosures: Record<string, boolean>;
}
export interface SubagentPaneState extends PaneSnapshot {
  cursor: number;
  seen: Set<string>;
  terminal: boolean;
  scrollTop: number;
  followBottom: boolean;
  getSnapshot: () => PaneSnapshot;
  subscribe: (listener: () => void) => () => void;
  connect: () => void;
  retry: () => void;
  dispose: (persist?: boolean) => void;
  flush: () => void;
  setScroll: (top: number, followBottom: boolean) => void;
  setDisclosure: (key: string, open: boolean) => void;
  hasSubscribers: () => boolean;
}

type StreamFetch = (path: string, init: RequestInit) => Promise<Response>;

function taskStatus(progress: SubagentProgress, fallback: string): string {
  switch (progress.phase) {
    case "done":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "waiting":
      return "Waiting for input";
    default:
      return fallback;
  }
}

function createPane(
  session: SubagentSession,
  fetchStream: StreamFetch,
  acquire: (signal: AbortSignal) => Promise<() => void>,
  persistence?: { storage: SubagentStorage; owner: Promise<string> },
): SubagentPaneState {
  const reducer = chatMessageReducer();
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  let restored = false;
  let owner: string | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const key = subagentKey(session);
  const persistView = () => {
    if (owner)
      writeSubagentView(subagentViewKey(owner, key), {
        scrollTop: state.scrollTop,
        followBottom: state.followBottom,
        disclosures: state.disclosures,
      });
  };
  const flush = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!owner || !persistence || !state.ready) return;
    const record: SubagentCheckpoint = {
      version: 1,
      updatedAt: Date.now(),
      cursor: state.cursor,
      data: state.data,
      progress: state.progress,
      status: state.status,
      terminal: state.terminal,
      error: state.error,
      seen: [...state.seen].slice(-256),
    };
    if (new TextEncoder().encode(JSON.stringify(record)).byteLength <= 512 * 1024)
      void persistence.storage.save(owner, key, record).catch(() => {});
    persistView();
  };
  const scheduleSave = () => {
    if (!saveTimer && persistence) saveTimer = setTimeout(flush, 1000);
  };
  let snapshot: PaneSnapshot = {
    ready: false,
    disclosures: {},
    data: reducer.initial(),
    status: "Connecting…",
    progress: initialSubagentProgress(),
  };
  let catchingUp = false;
  let pendingSnapshot = snapshot;
  const publish = () => {
    if (disposed || catchingUp) return;
    // Capture now: replay may mutate state before the batched notification runs.
    pendingSnapshot = {
      ready: state.ready,
      disclosures: state.disclosures,
      data: state.data,
      progress: state.progress,
      status: state.status,
      error: state.error,
    };
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      snapshot = pendingSnapshot;
      listeners.forEach((listener) => listener());
    }, 16);
  };
  const connect = () => {
    // Subscribers share one connection and resume from the retained cursor.
    if (disposed || controller || state.terminal) return;

    const active = new AbortController();
    controller = active;
    void (async () => {
      let reconnect = false;
      try {
        if (!restored && persistence) {
          owner = await persistence.owner;
          if (disposed || active.signal.aborted) return;
          const saved = await persistence.storage.load(owner, key).catch(() => undefined);
          if (disposed || active.signal.aborted) return;
          if (validCheckpoint(saved)) {
            state.data = saved.data;
            state.progress = saved.progress;
            state.cursor = saved.cursor;
            state.seen = new Set(saved.seen);
            state.terminal = saved.terminal;
            state.status = taskStatus(saved.progress, saved.status);
            state.error = saved.error;
            state.ready = true;
          }
          const view = readSubagentView(subagentViewKey(owner, key));
          if (view) {
            state.scrollTop = view.scrollTop;
            state.followBottom = view.followBottom;
            state.disclosures = view.disclosures;
          }
        }
        restored = true;
        publish();
        if (state.terminal) return;
        state.error = undefined;
        if (state.status === "Disconnected") state.status = "Connecting…";
        publish();
        const release = await acquire(active.signal);
        let response: Response;
        try {
          active.signal.throwIfAborted();
          response = await fetchStream(subagentStreamPath(session, state.cursor), {
            cache: "no-store",
            signal: active.signal,
          });
        } catch (error) {
          release();
          throw error;
        }
        active.signal.addEventListener("abort", release, { once: true });
        try {
          const rawTail = response.headers.get("x-eve-stream-tail-index");
          const tail = rawTail !== null && /^-?\d+$/.test(rawTail) ? Number(rawTail) : undefined;
          catchingUp = tail !== undefined && Number.isSafeInteger(tail) && state.cursor <= tail;
          if (!catchingUp) {
            state.ready = true;
            publish();
          }
          for await (const event of readSubagentEvents(response, active.signal)) {
            if (active.signal.aborted) return;
            state.cursor++;
            if (catchingUp && state.cursor > tail!) {
              catchingUp = false;
              state.ready = true;
            }
            if (event.meta.id && state.seen.has(event.meta.id)) {
              scheduleSave();
              publish();
              continue;
            }
            if (event.meta.id) state.seen.add(event.meta.id);
            if (state.seen.size > 256) state.seen.delete(state.seen.values().next().value!);
            state.data = reducer.reduce(state.data, event);
            state.progress = reduceSubagentProgress(state.progress, event);
            if (event.type === "session.completed" || event.type === "session.failed") {
              state.terminal = true;
              // A terminal event may precede bookkeeping records in the tail.
              // We stop reading here, so release the replay gate before publishing.
              catchingUp = false;
              state.ready = true;
              if (event.type === "session.failed") state.error = event.data.message;
            }
            state.status = taskStatus(
              state.progress,
              event.type === "session.waiting" ? "Idle" : "Working",
            );
            scheduleSave();
            publish();
            if (
              state.terminal ||
              (!catchingUp &&
                (state.progress.phase === "waiting" || state.progress.endedAt !== undefined))
            )
              break;
          }
          reconnect =
            !state.terminal &&
            state.progress.phase !== "waiting" &&
            state.progress.endedAt === undefined &&
            !active.signal.aborted;
        } finally {
          release();
          active.signal.removeEventListener("abort", release);
        }
      } catch (cause) {
        if (!active.signal.aborted) {
          catchingUp = false;
          state.status = "Disconnected";
          state.error =
            cause instanceof Error ? cause.message : "Unable to load this subagent session.";
          publish();
        }
      } finally {
        catchingUp = false;
        if (!disposed) flush();
        if (controller === active) controller = undefined;
        if (reconnect && !disposed && listeners.size) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, 2000);
        }
      }
    })();
  };
  const state: SubagentPaneState = {
    ...snapshot,
    cursor: 0,
    seen: new Set(),
    terminal: false,
    scrollTop: 0,
    followBottom: true,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => {
        listeners.delete(listener);
        queueMicrotask(() => {
          if (!listeners.size) {
            clearTimeout(reconnectTimer);
            controller?.abort();
            controller = undefined;
            flush();
          }
        });
      };
    },
    connect,
    flush,
    setScroll(top, followBottom) {
      state.scrollTop = top;
      state.followBottom = followBottom;
      scheduleSave();
    },
    setDisclosure(key, open) {
      state.disclosures = { ...state.disclosures, [key]: open };
      persistView();
      publish();
    },
    hasSubscribers: () => listeners.size > 0,
    retry() {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      connect();
    },
    dispose(persist = true) {
      if (persist) flush();
      clearTimeout(saveTimer);
      disposed = true;
      controller?.abort();
      clearTimeout(reconnectTimer);
      clearTimeout(publishTimer);
      listeners.clear();
    },
  };
  return state;
}

/** Workspace-local cached state; active subscribers own stream connections. */
export function createSubagentPaneCache(fetchStream?: StreamFetch, storage?: SubagentStorage) {
  const client = new Client({ host: "" });
  const fetcher = fetchStream ?? ((path, init) => client.fetch(path, init));
  const entries = new Map<string, SubagentPaneState>();
  let active = 0;
  const queue = new Set<() => void>();
  const acquire = (signal: AbortSignal) =>
    new Promise<() => void>((resolve, reject) => {
      const abort = () => {
        queue.delete(start);
        reject(signal.reason);
      };
      const start = () => {
        if (active >= 4) {
          queue.add(start);
          return;
        }
        queue.delete(start);
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active--;
          queue.values().next().value?.();
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      start();
    });
  let retainCount = 0;
  let owner: string | undefined;
  let resolveOwner: (owner: string) => void;
  let ownerReady = new Promise<string>((resolve) => {
    resolveOwner = resolve;
  });
  const clear = (forget = false) => {
    entries.forEach((entry) => entry.dispose(!forget));
    if (forget && owner && storage) void storage.clear(owner).catch(() => {});
    entries.clear();
  };
  return {
    clear,
    setOwner(next?: string) {
      if (next === owner) return;
      if (owner) {
        clear(true);
        ownerReady = new Promise<string>((resolve) => {
          resolveOwner = resolve;
        });
      }
      owner = next;
      if (next) resolveOwner!(next);
    },
    flush() {
      entries.forEach((entry) => entry.flush());
      for (const [key, entry] of entries) {
        if (entries.size <= 20) break;
        if (!entry.hasSubscribers()) {
          entry.dispose();
          entries.delete(key);
        }
      }
    },
    retain() {
      retainCount++;
      return () => {
        retainCount--;
        // Strict Mode reconnects effects synchronously; don't discard live stores then.
        queueMicrotask(() => {
          if (retainCount === 0) clear();
        });
      };
    },
    get(session: SubagentSession): SubagentPaneState {
      const key = subagentKey(session);
      const state =
        entries.get(key) ??
        createPane(session, fetcher, acquire, storage ? { storage, owner: ownerReady } : undefined);
      entries.delete(key);
      entries.set(key, state);
      return state;
    },
  };
}
