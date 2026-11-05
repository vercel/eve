import { type IdbDatabase, openDatabase, request } from "./indexed-db.js";
import type { SandboxFileEntry, SandboxFileStore } from "#execution/sandbox/memory-files.js";

const WORKSPACES = "workspaces";

/**
 * Memory sandboxes' workspaces in the page's IndexedDB (database `name`, one record per session),
 * so a session resumed after a reload finds the files its shell wrote.
 */
export function createIndexedDbSandboxFileStore(name = "eve-sandbox-files"): SandboxFileStore {
  let opened: Promise<IdbDatabase> | undefined;
  const workspaces = async (mode: "readonly" | "readwrite") => {
    opened ??= openDatabase(name, 1, (db) => db.createObjectStore(WORKSPACES));
    return (await opened)
      .transaction(WORKSPACES, mode)
      .objectStore<readonly SandboxFileEntry[]>(WORKSPACES);
  };
  return {
    async load(sessionId) {
      return await request((await workspaces("readonly")).get(sessionId));
    },
    async save(sessionId, entries) {
      await request((await workspaces("readwrite")).put(entries, sessionId));
    },
    async delete(sessionId) {
      await request((await workspaces("readwrite")).delete(sessionId));
    },
  };
}
