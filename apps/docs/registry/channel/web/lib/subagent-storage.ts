import type { ChatMessageData } from "./chat-message-reducer.ts";
import type { SubagentProgress } from "./subagent-progress.ts";

export interface SubagentCheckpoint {
  version: 1;
  updatedAt: number;
  cursor: number;
  data: ChatMessageData;
  progress: SubagentProgress;
  status: string;
  terminal: boolean;
  error?: string;
  seen: string[];
}
export interface SubagentStorage {
  load(owner: string, key: string): Promise<SubagentCheckpoint | undefined>;
  save(owner: string, key: string, value: SubagentCheckpoint): Promise<void>;
  clear(owner: string): Promise<void>;
}
const maxAge = 7 * 24 * 60 * 60 * 1000;
export function validCheckpoint(value: unknown): value is SubagentCheckpoint {
  if (!value || typeof value !== "object") return false;
  const v = value as SubagentCheckpoint;
  return (
    v.version === 1 &&
    Number.isSafeInteger(v.cursor) &&
    v.cursor >= 0 &&
    Number.isFinite(v.updatedAt) &&
    Date.now() - v.updatedAt < maxAge &&
    typeof v.status === "string" &&
    typeof v.terminal === "boolean" &&
    Array.isArray(v.seen) &&
    v.seen.every((id) => typeof id === "string") &&
    !!v.progress &&
    ["working", "done", "failed", "cancelled", "waiting"].includes(v.progress.phase) &&
    typeof v.progress.update === "string" &&
    !!v.data?.subagents &&
    Array.isArray(v.data.messages) &&
    v.data.messages.every(
      (message) =>
        message &&
        typeof message.id === "string" &&
        ["assistant", "user"].includes(message.role) &&
        Array.isArray(message.parts) &&
        message.parts.every(validPart),
    )
  );
}

function validPart(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  switch (part.type) {
    case "text":
    case "reasoning":
      return typeof part.text === "string";
    case "step-start":
      return true;
    case "file":
      return typeof part.mediaType === "string";
    case "authorization":
      return typeof part.name === "string" && typeof part.displayName === "string";
    case "dynamic-tool":
      return (
        typeof part.toolCallId === "string" &&
        typeof part.toolName === "string" &&
        typeof part.state === "string"
      );
    default:
      return false;
  }
}

/** One atomic record binds the rendered projection to its exact stream offset. */
export function createBrowserSubagentStorage(): SubagentStorage {
  let database: Promise<IDBDatabase> | undefined;
  const open = () =>
    (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      const request = indexedDB.open("eve-web-subagent-checkpoints", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("sessions", { keyPath: "id" });
        store.createIndex("owner", "owner");
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        blocked = true;
        database = undefined;
        reject(new Error("Session storage blocked."));
      };
    }));
  return {
    async load(owner, key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").get([owner, key]);
        request.onsuccess = () =>
          resolve(validCheckpoint(request.result?.value) ? request.result.value : undefined);
        request.onerror = () => reject(request.error);
      });
    },
    async save(owner, key, value) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        const store = tx.objectStore("sessions");
        const current = store.get([owner, key]);
        current.onsuccess = () => {
          // A slower tab must never replace a newer transcript with an older cursor.
          if (
            !validCheckpoint(current.result?.value) ||
            current.result.value.cursor <= value.cursor
          )
            store.put({ id: [owner, key], owner, value });
        };
        const list = store.index("owner").getAll(owner);
        list.onsuccess = () => {
          const others = list.result
            .filter((row) => row.id[1] !== key)
            .sort((a, b) => b.value.updatedAt - a.value.updatedAt);
          others.forEach((row, index) => {
            if (index >= 19 || !validCheckpoint(row.value)) store.delete(row.id);
          });
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
    async clear(owner) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        const store = tx.objectStore("sessions");
        const request = store.index("owner").getAllKeys(owner);
        request.onsuccess = () => request.result.forEach((key) => store.delete(key));
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
  };
}

export interface SubagentViewState {
  scrollTop: number;
  followBottom: boolean;
  disclosures: Record<string, boolean>;
}
export function subagentViewKey(owner: string, key: string) {
  return `eve:web:subagent-view:v1:${JSON.stringify([owner, key])}`;
}
export function readSubagentView(key: string): SubagentViewState | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      Number.isFinite(value.scrollTop) &&
      value.scrollTop >= 0 &&
      typeof value.followBottom === "boolean" &&
      value.disclosures &&
      Object.values(value.disclosures).every((open) => typeof open === "boolean")
    )
      return value;
  } catch {
    /* Storage may be disabled. */
  }
}
export function writeSubagentView(key: string, value: SubagentViewState) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Keep the in-memory view. */
  }
}
