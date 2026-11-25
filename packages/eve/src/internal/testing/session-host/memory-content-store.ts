import type { SessionContentStore } from "#execution/durable.js";
import { sha256 } from "#runtime-env/sha256.js";

export interface MemoryContentStore extends SessionContentStore {
  size(sessionId: string): number;
}

export function createMemoryContentStore(): MemoryContentStore {
  const sessions = new Map<string, Map<string, Uint8Array>>();
  return {
    async put(sessionId, content) {
      const id = [...sha256(content)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      let stored = sessions.get(sessionId);
      if (stored === undefined) sessions.set(sessionId, (stored = new Map()));
      stored.set(id, content.slice());
      return id;
    },
    async get(sessionId, id) {
      const content = sessions.get(sessionId)?.get(id);
      if (content === undefined)
        throw new Error(`Session "${sessionId}" has no content "${id}" in the store.`);
      return content;
    },
    async delete(sessionId) {
      sessions.delete(sessionId);
    },
    size: (sessionId) => sessions.get(sessionId)?.size ?? 0,
  };
}
