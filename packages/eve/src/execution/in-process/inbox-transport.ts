import type {
  InboxHook,
  SessionInboxPayload,
  SessionInboxTransport,
} from "#execution/session-inbox/inbox.js";
import type { WorkflowToolRunMessageBatch } from "#execution/tools/workflow/messages.js";

// Session addresses in memory: a token names at most one open address, which its session reads
// in order. What arrives before anyone reads it waits. Nothing survives the process.

type Arrival = SessionInboxPayload | WorkflowToolRunMessageBatch;

interface MemoryHook extends InboxHook {
  readonly queue: Arrival[];
  readonly waiters: Set<() => void>;
  disposed: boolean;
}

export interface MemoryInboxRegistry {
  /** The transport one session's inbox opens its addresses with. */
  transportFor(sessionId: string): SessionInboxTransport<MemoryHook>;
  /** Delivers to the address `token` names; `undefined` when no session holds it. */
  deliver(token: string, payload: Arrival): { readonly sessionId: string } | undefined;
  /** The session that holds `token`, if one does. */
  holder(token: string): string | undefined;
  /** Closes every open address, so each session's inbox reads nothing more. */
  closeAll(): void;
}

export function createMemoryInboxRegistry(): MemoryInboxRegistry {
  const held = new Map<string, { readonly hook: MemoryHook; readonly sessionId: string }>();
  const opened = new Set<MemoryHook>();
  const wake = (hook: MemoryHook): void => {
    for (const resolve of hook.waiters) resolve();
    hook.waiters.clear();
  };
  const close = (hook: MemoryHook): void => {
    hook.disposed = true;
    opened.delete(hook);
    wake(hook);
    if (held.get(hook.token)?.hook === hook) held.delete(hook.token);
  };

  return {
    holder: (token) => held.get(token)?.sessionId,
    deliver(token, payload) {
      const holder = held.get(token);
      if (holder === undefined) return undefined;
      holder.hook.queue.push(payload);
      wake(holder.hook);
      return { sessionId: holder.sessionId };
    },
    closeAll() {
      for (const hook of opened) close(hook);
    },
    transportFor(sessionId) {
      return {
        open(token) {
          const hook: MemoryHook = {
            disposed: false,
            queue: [],
            token,
            waiters: new Set(),
            async *[Symbol.asyncIterator]() {
              while (true) {
                const next = hook.queue.shift();
                if (next !== undefined) {
                  yield next;
                  continue;
                }
                if (hook.disposed) return;
                await new Promise<void>((resolve) => hook.waiters.add(resolve));
              }
            },
          };
          opened.add(hook);
          return hook;
        },
        async confirm(hook) {
          const current = held.get(hook.token);
          if (current !== undefined && current.sessionId !== sessionId)
            throw new Error(`Session address "${hook.token}" belongs to another session.`);
          held.set(hook.token, { hook, sessionId });
        },
        async dispose(hook) {
          close(hook);
        },
        // Nothing here takes an address from the session that holds it.
        isTakenOver: () => false,
        // One owner per session, for as long as this process runs it.
        ownerRunId: () => sessionId,
      };
    },
  };
}
