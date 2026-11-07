import type { InMemoryFs } from "just-bash";

import { connectJustBash } from "#execution/sandbox/just-bash-connection.js";
import { defineSandboxProvider, type SandboxConnection } from "#public/sandbox/provider.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";
import {
  restoreWorkspace,
  type SandboxFileStore,
  snapshotWorkspace,
} from "#execution/sandbox/memory-files.js";

// A sandbox in memory: just-bash's interpreter over an in-memory filesystem, one per session,
// through the same connection the disk binding uses (`just-bash-connection.ts`), so eve's sandbox
// tools behave as they do on disk and nothing reaches the host. The workspace outlives the
// interpreter: after each command, write or removal the session's files go to a
// `SandboxFileStore`, and a session resumed elsewhere (a page after a reload, another host in the
// process) starts from them.

type MemorySessionState = { readonly version: 1 };

const MEMORY_SESSION_STATE: MemorySessionState = { version: 1 };

/** What a memory sandbox keeps its sessions' workspaces in. */
export interface MemorySandboxEnvironment {
  readonly files: SandboxFileStore;
}

const sessions = new Map<string, Promise<SandboxConnection>>();

/** One session's connection, its workspace restored. just-bash (~1.5 MB) loads with the first. */
function sessionOf(id: string, files: SandboxFileStore): Promise<SandboxConnection> {
  let session = sessions.get(id);
  if (session === undefined) {
    session = (async () => {
      // just-bash's browser bundle, which eve vendors without Node built-ins
      // (`scripts/vendor-compiled/just-bash-browser.mjs`): a page and a Node program load the same
      // interpreter, and neither needs the optional `just-bash` peer.
      const justBash = await import("#compiled/just-bash/browser/index.js");
      const filesystem: InMemoryFs = new justBash.InMemoryFs();
      await filesystem.mkdir(WORKSPACE_ROOT, { recursive: true });
      const saved = await files.load(id);
      if (saved !== undefined) await restoreWorkspace(filesystem, saved);
      const { connection } = await connectJustBash({ filesystem, justBash });
      return persisting(connection, async () => {
        await files.save(id, await snapshotWorkspace(filesystem, WORKSPACE_ROOT));
      });
    })();
    sessions.set(id, session);
    session.catch(() => sessions.delete(id));
  }
  return session;
}

/** `connection`, saving the workspace once each change to it settles, one save at a time. */
function persisting(connection: SandboxConnection, save: () => Promise<void>): SandboxConnection {
  let saving: Promise<void> = Promise.resolve();
  const persist = () => (saving = saving.then(save, save));
  return {
    ...connection,
    async spawn(options) {
      const process = await connection.spawn(options);
      return {
        ...process,
        async wait() {
          const result = await process.wait();
          await persist();
          return result;
        },
      };
    },
    async writeFiles(options) {
      await connection.writeFiles(options);
      await persist();
    },
    async removePath(options) {
      await connection.removePath(options);
      await persist();
    },
  };
}

/** In-memory just-bash sandboxes. See `memorySandbox()` (`#runtime/sandbox/memory-sandbox.js`). */
export const MemorySandbox = defineSandboxProvider({
  name: "memory",
  environment: ({ files }: MemorySandboxEnvironment) => ({
    // Nothing to build: a new session starts from an empty workspace.
    prepare: async () => null,
    start: async (ctx) => ({
      connection: await sessionOf(ctx.session.id, files),
      state: MEMORY_SESSION_STATE,
    }),
    resume: async (ctx) => await sessionOf(ctx.session.id, files),
    // The session's files go with it.
    onSessionEnd: async (ctx) => {
      const session = sessions.get(ctx.session.id);
      sessions.delete(ctx.session.id);
      await (await session?.catch(() => undefined))?.stop();
      await files.delete(ctx.session.id);
    },
  }),
});
