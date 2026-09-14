import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverPayload, HookPayload, SessionCommand } from "#channel/types.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import {
  flattenSessionHookClaims,
  type SessionHookClaims,
} from "#execution/session-hook-claims.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

/** All session addresses accept the same protocol. Callback routes construct
 * their own message kind; they never accept arbitrary session commands. */
export interface AuthorizationCallbackPayload {
  readonly kind: "authorization-callback";
  readonly payloads: DeliverPayload[];
}

export type SessionInboxPayload =
  | HookPayload
  | SessionCommand
  | WorkflowToolRunMessage
  | AuthorizationCallbackPayload;

type ReadMode = "session" | "interrupt" | "runtime";
interface Source {
  readonly hook: Hook<SessionInboxPayload>;
  registered?: Promise<void>;
  stopping: boolean;
  closed: boolean;
}
interface Read {
  readonly value: SessionInboxPayload;
}
interface PendingRead {
  readonly promise: Promise<SessionInboxLease | undefined>;
  read?: Read;
}

export interface SessionInboxLease {
  readonly value: SessionInboxPayload;
  consume(): void;
}

export interface SessionInboxReader {
  read(mode?: ReadMode): Promise<SessionInboxLease | undefined>;
  drain(): SessionInboxPayload[];
  hasPending(): boolean;
  hasReadyAuthorization(): boolean;
  setAuthorizationWindow(open: boolean): void;
  restore(payloads: readonly SessionInboxPayload[]): void;
}

export interface SessionInboxOwnership {
  readonly hookClaims: SessionHookClaims;
  claimSessionHook(token: string): Promise<void>;
}
export interface SessionInbox extends SessionInboxReader, SessionInboxOwnership {}
export interface SessionInboxHandle extends SessionInbox {
  dispose(): Promise<void>;
  release(): Promise<SessionInboxPayload[]>;
}

/** Commit one registration batch and settle every claim before rollback. */
export async function claimSessionHooks(
  inbox: Pick<SessionInbox, "claimSessionHook">,
  claims: SessionHookClaims,
): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...new Set(flattenSessionHookClaims(claims))].map((token) => inbox.claimSessionHook(token)),
  );
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}

export async function claimSessionHookAliases(
  inbox: Pick<SessionInbox, "claimSessionHook">,
  aliases: readonly string[],
): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...new Set(aliases)].map((token) => inbox.claimSessionHook(token)),
  );
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}

/** One queue for the session lifetime. Reads only select entries; consumption
 * happens explicitly, so a losing Promise.race cannot steal a message. */
export function createSessionInbox(sessionId: string): SessionInboxHandle {
  const sources: Source[] = [];
  const queue: Read[] = [];
  const pending = new Map<ReadMode, PendingRead>();
  const waiters = new Set<() => void>();
  let authorizationOpen = false;
  let failure: { error: unknown } | undefined;
  const notify = (): void => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const wait = (): Promise<void> => new Promise((resolve) => waiters.add(resolve));
  const eligible = (value: SessionInboxPayload, mode: ReadMode): boolean => {
    if (mode === "interrupt")
      return value.kind === "cancel" || value.kind === "reset" || value.kind === "session-timeout";
    if (value.kind === "authorization-callback") return authorizationOpen;
    if (isWorkflowMessage(value)) return mode === "runtime";
    return true;
  };
  const invalidate = (reads: readonly Read[]): void => {
    for (const [mode, entry] of pending)
      if (entry.read !== undefined && reads.includes(entry.read)) pending.delete(mode);
    notify();
  };
  const pump = async (source: Source): Promise<void> => {
    const iterator = source.hook[Symbol.asyncIterator]();
    try {
      while (!source.stopping) {
        // Each source may additionally have one in-flight read.
        while (queue.length >= 1024 && !source.stopping) await wait();
        if (source.stopping) break;
        const result = await iterator.next();
        if (result.done) break;
        queue.push({ value: result.value });
        notify();
      }
    } catch (error) {
      if (!source.stopping) failure = { error };
    } finally {
      source.closed = true;
      notify();
    }
  };
  const consume = (mode: ReadMode, read: Read): void => {
    const entry = pending.get(mode);
    if (entry?.read !== read) throw new Error("Session message lease is no longer current.");
    const index = queue.indexOf(read);
    if (index === -1) throw new Error("Session message was already consumed.");
    queue.splice(index, 1);
    invalidate([read]);
  };
  const nextRead = (mode: ReadMode = "session"): Promise<SessionInboxLease | undefined> => {
    const existing = pending.get(mode);
    if (existing !== undefined) return existing.promise;
    const entry: PendingRead = {
      promise: Promise.resolve().then(async () => {
        while (true) {
          if (failure !== undefined) throw failure.error;
          const read = queue.find(({ value }) => eligible(value, mode));
          if (read !== undefined) {
            entry.read = read;
            return { consume: () => consume(mode, read), value: read.value };
          }
          if (sources.every((source) => source.closed || source.stopping)) return undefined;
          await wait();
        }
      }),
    };
    pending.set(mode, entry);
    return entry.promise;
  };

  return {
    get hookClaims() {
      const [stable, ...aliases] = sources.map(({ hook }) => hook.token);
      if (stable === undefined) throw new Error("Session inbox has no stable hook claim.");
      return { aliases, stable };
    },
    async claimSessionHook(token) {
      if (!token) throw new Error("A session alias requires a nonempty continuation token.");
      const existing = sources.find(({ hook }) => hook.token === token);
      if (existing !== undefined) return await existing.registered;
      if (sources.length >= 256) throw new Error("A session may claim at most 256 addresses.");
      const source: Source = {
        hook: createHook<SessionInboxPayload>({ token, metadata: { sessionId } }),
        stopping: false,
        closed: false,
      };
      // Reserve the slot before awaiting registration: parallel claims retain
      // deterministic order and duplicate calls cannot create another hook.
      sources.push(source);
      try {
        source.registered = claimHookOwnership(source.hook);
        await source.registered;
        void pump(source);
      } catch (error) {
        sources.splice(sources.indexOf(source), 1);
        throw error;
      }
    },
    read: nextRead,
    drain() {
      if (failure !== undefined) throw failure.error;
      const reads = queue.filter(({ value }) => eligible(value, "session"));
      for (const read of reads) queue.splice(queue.indexOf(read), 1);
      invalidate(reads);
      return reads.map(({ value }) => value);
    },
    hasPending() {
      if (failure !== undefined) throw failure.error;
      return queue.length > 0;
    },
    hasReadyAuthorization() {
      return (
        queue.find(({ value }) => eligible(value, "session"))?.value.kind ===
        "authorization-callback"
      );
    },
    setAuthorizationWindow(open) {
      authorizationOpen = open;
      for (const mode of ["session", "runtime"] as const) {
        const entry = pending.get(mode);
        if (
          entry?.read !== undefined &&
          entry.read !== queue.find(({ value }) => eligible(value, mode))
        )
          pending.delete(mode);
      }
      notify();
    },
    restore(payloads) {
      if (sources.length === 0)
        throw new Error("Cannot restore session commands before reclaiming the session hooks.");
      // Restored payloads were accepted before anything the reclaimed pumps
      // have enqueued since, so they must precede the current queue.
      queue.unshift(...payloads.map((value) => ({ value })));
      notify();
    },
    async dispose() {
      // Accepted-but-unread payloads are dropped: disposal ends the session.
      await this.release();
    },
    async release() {
      const released = sources.splice(0);
      for (const source of released) source.stopping = true;
      notify();
      await Promise.all(released.map(({ hook }) => disposeHook(hook)));
      await Promise.resolve();
      const accepted = queue.splice(0).map(({ value }) => value);
      pending.clear();
      notify();
      return accepted;
    },
  };
}

export function isWorkflowMessage(value: SessionInboxPayload): value is WorkflowToolRunMessage {
  return value.kind === "report" || value.kind === "request" || value.kind === "outcome";
}
