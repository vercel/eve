import type { InMemoryFs } from "just-bash";

import { connectJustBash } from "#execution/sandbox/just-bash-connection.js";
import { importJustBashModule } from "#execution/sandbox/bindings/just-bash-runtime.js";
import { defineSandboxProvider, type SandboxConnection } from "#public/sandbox/provider.js";
import { WORKSPACE_ROOT } from "#runtime/workspace/types.js";

// A sandbox in memory: just-bash's interpreter over an in-memory filesystem, one per session,
// through the same connection the disk binding uses (`just-bash-connection.ts`), so eve's sandbox
// tools behave as they do on disk and nothing reaches the host. Its files last as long as the
// process.

type MemorySessionState = { readonly version: 1 };

const MEMORY_SESSION_STATE: MemorySessionState = { version: 1 };

const sessions = new Map<string, Promise<SandboxConnection>>();

/** One session's connection, made on its first use. just-bash loads with the first. */
function sessionOf(id: string, appRoot: string): Promise<SandboxConnection> {
  let session = sessions.get(id);
  if (session === undefined) {
    session = (async () => {
      const justBash = await importJustBashModule(appRoot);
      const filesystem: InMemoryFs = new justBash.InMemoryFs();
      await filesystem.mkdir(WORKSPACE_ROOT, { recursive: true });
      return (await connectJustBash({ filesystem, justBash })).connection;
    })();
    sessions.set(id, session);
    session.catch(() => sessions.delete(id));
  }
  return session;
}

/** In-memory just-bash sandboxes. See `memorySandbox()` (`#runtime/sandbox/memory-sandbox.js`). */
export const MemorySandbox = defineSandboxProvider({
  name: "memory",
  environment: () => ({
    // Nothing to build: a new session starts from an empty workspace.
    prepare: async () => null,
    start: async (ctx) => ({
      connection: await sessionOf(ctx.session.id, ctx.resolveProjectPath(".")),
      state: MEMORY_SESSION_STATE,
    }),
    resume: async (ctx) => await sessionOf(ctx.session.id, ctx.resolveProjectPath(".")),
    // The session's files go with it.
    onSessionEnd: async (ctx) => {
      const session = sessions.get(ctx.session.id);
      sessions.delete(ctx.session.id);
      await (await session?.catch(() => undefined))?.stop();
    },
  }),
});
