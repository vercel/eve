import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { HookPayload, SessionCommand } from "#channel/types.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { SESSION_INBOX_SESSION_ID_METADATA_KEY } from "#execution/wire/session-inbox-contract.js";
/**
 * Payloads accepted by a session owner's stable and channel aliases.
 *
 * This union is the hook's transport typing only. The owner routes payloads
 * after the inbox surfaces them; the inbox owns no command semantics.
 */
export type SessionInboxPayload = HookPayload | SessionCommand;

interface HookRead {
  readonly order: number;
  readonly result: IteratorResult<SessionInboxPayload>;
  readonly state: SessionCommandHookState;
}

interface SessionCommandHookState {
  readonly hook: Hook<SessionInboxPayload>;
  readonly iterator: AsyncIterator<SessionInboxPayload>;
  closed: boolean;
  enabled: boolean;
  stopping: boolean;
  readonly buffered: HookRead[];
}

/** Which hook family produced an inbox read. */
export type SessionInboxSource = "authorization" | "session";

/**
 * Multiplexes an additive set of session-address hooks and one window-gated
 * authorization-callback hook. The stable session inbox is the first session
 * hook; every continuation alias adds another hook without retiring an older
 * address.
 */
export interface SessionCommandInbox {
  /** Session-address hook tokens in claim order, beginning with the stable inbox. */
  readonly sessionHookTokens: readonly string[];
  /**
   * Claims the session's authorization-callback hook as an inbox source.
   * Its reads stay stashed until {@link setAuthorizationWindow} opens, so
   * callbacks never surface as ordinary session activity.
   */
  claimAuthorization(token: string): Promise<void>;
  /** Adds one session address to the merged inbox. Repeated claims are idempotent. */
  claimSessionHook(token: string): Promise<void>;
  consumeNext(): void;
  /** Consumes all eligible arrivals at a committed execution boundary. */
  drain(): SessionInboxPayload[];
  /** Whether an authorization read is already eligible to be consumed. */
  hasReadyAuthorization(): boolean;
  /** Whether an accepted command is already waiting behind the current one. */
  hasPending(): Promise<boolean>;
  next(): Promise<IteratorResult<SessionInboxPayload>>;
  /**
   * Like {@link next} but reports which hook family produced the read.
   * Reads surface in one arrival order across every source, which keeps
   * waits that interleave authorization callbacks with ordinary session
   * activity deterministic under workflow replay.
   */
  nextWithSource(): Promise<{
    result: IteratorResult<SessionInboxPayload>;
    source: SessionInboxSource;
  }>;
  /** Restores commands drained while an abandoned handoff released the hooks. */
  restore(payloads: readonly SessionInboxPayload[]): void;
  /** Opens or closes the surfacing window for authorization-callback reads. */
  setAuthorizationWindow(open: boolean): void;
}

/** Adds workflow-entry lifecycle ownership to a session command inbox. */
export interface SessionCommandInboxHandle extends SessionCommandInbox {
  dispose(): Promise<void>;
  /** Releases all claims and returns accepted reads not yet consumed. */
  release(): Promise<SessionInboxPayload[]>;
}

/**
 * Creates the command inbox owned by one session owner.
 *
 * Every claimed session hook is retained for the session's lifetime. Each
 * source has one background reader. The readers continuously merge deliveries
 * into one queue, including while the owner is awaiting a model or tool step.
 */
export function createSessionCommandInbox(sessionId: string): SessionCommandInboxHandle {
  const sessionHooks: SessionCommandHookState[] = [];
  let authorization: SessionCommandHookState | undefined;
  const ready: HookRead[] = [];
  let nextOrder = 0;
  let offered: Promise<IteratorResult<SessionInboxPayload>> | null = null;
  let offeredRead: HookRead | undefined;
  let wake: (() => void) | undefined;
  let failure: { error: unknown } | undefined;
  const capacityWaiters = new Set<() => void>();
  const MAX_BUFFERED = 1024;
  const enqueue = (read: HookRead): void => {
    ready.push(read);
    ready.sort((left, right) => left.order - right.order);
    wake?.();
    wake = undefined;
  };

  const pump = async (state: SessionCommandHookState): Promise<void> => {
    try {
      while (!state.stopping && !state.closed) {
        if (states().reduce((count, source) => count + source.buffered.length, 0) >= MAX_BUFFERED) {
          await new Promise<void>((resolve) => capacityWaiters.add(resolve));
          continue;
        }
        const result = await state.iterator.next();
        if (result.done) {
          state.closed = true;
          wake?.();
          wake = undefined;
          return;
        }
        const read: HookRead = { order: nextOrder++, result, state };
        state.buffered.push(read);
        if (state.enabled) enqueue(read);
      }
    } catch (error) {
      if (state.stopping) return;
      failure = { error };
      wake?.();
      wake = undefined;
    }
  };

  const enable = (state: SessionCommandHookState): void => {
    state.enabled = true;
    for (const read of state.buffered) enqueue(read);
  };

  const createState = (token: string): SessionCommandHookState => {
    const hook = createHook<SessionInboxPayload>({
      metadata: {
        [SESSION_INBOX_SESSION_ID_METADATA_KEY]: sessionId,
      },
      token,
    });
    return {
      closed: false,
      enabled: false,
      hook,
      iterator: hook[Symbol.asyncIterator](),
      stopping: false,
      buffered: [],
    };
  };

  const states = (): readonly SessionCommandHookState[] =>
    authorization === undefined ? sessionHooks : [...sessionHooks, authorization];

  const nextRead = (): Promise<IteratorResult<SessionInboxPayload>> => {
    if (sessionHooks.length === 0) {
      throw new Error("Cannot wait for session commands before claiming a session hook.");
    }

    if (offered !== null) return offered;

    offered = (async () => {
      while (ready.length === 0) {
        if (failure !== undefined) throw failure.error;
        if (states().every((state) => state.closed || state.stopping))
          return { done: true as const, value: undefined };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      const read = ready.shift()!;
      offeredRead = read;
      return read.result;
    })();
    return offered;
  };

  return {
    get sessionHookTokens(): readonly string[] {
      return sessionHooks.map((state) => state.hook.token);
    },

    async claimAuthorization(token: string): Promise<void> {
      if (sessionHooks.some((state) => state.hook.token === token))
        throw new Error("An authorization callback cannot share a session address token.");
      if (authorization !== undefined) {
        if (authorization.hook.token === token) return;
        throw new Error("A session command inbox cannot change its authorization token.");
      }

      const candidate = createState(token);
      await claimHookOwnership(candidate.hook);
      // Stays disabled until the owner opens the authorization window;
      // resolved reads stash on the state and enqueue when it opens.
      authorization = candidate;
      void pump(candidate);
    },

    async claimSessionHook(token: string): Promise<void> {
      if (!token) throw new Error("A session alias requires a nonempty continuation token.");
      if (sessionHooks.some((state) => state.hook.token === token)) return;
      if (sessionHooks.length >= 256) throw new Error("A session may claim at most 256 addresses.");
      if (authorization?.hook.token === token)
        throw new Error("A session address cannot share its authorization callback token.");

      const candidate = createState(token);
      await claimHookOwnership(candidate.hook);
      sessionHooks.push(candidate);
      enable(candidate);
      void pump(candidate);
    },

    consumeNext(): void {
      if (offeredRead === undefined) {
        throw new Error("Cannot consume a session command before it resolves.");
      }

      const consumed = offeredRead;
      const index = consumed.state.buffered.indexOf(consumed);
      if (index !== -1) consumed.state.buffered.splice(index, 1);
      offeredRead = undefined;
      offered = null;
      for (const resolve of capacityWaiters) resolve();
      capacityWaiters.clear();
    },

    drain(): SessionInboxPayload[] {
      if (failure !== undefined) throw failure.error;
      const reads = offeredRead === undefined ? [...ready] : [offeredRead, ...ready];
      ready.length = 0;
      if (offeredRead !== undefined) {
        offeredRead = undefined;
        offered = null;
      }
      for (const read of reads) {
        const index = read.state.buffered.indexOf(read);
        if (index !== -1) read.state.buffered.splice(index, 1);
      }
      for (const resolve of capacityWaiters) resolve();
      capacityWaiters.clear();
      return reads.sort((a, b) => a.order - b.order).map((read) => read.result.value);
    },

    async dispose(): Promise<void> {
      await this.release();
    },

    hasReadyAuthorization(): boolean {
      if (authorization?.enabled !== true || authorization.buffered.length === 0) return false;
      if (offeredRead !== undefined) return offeredRead.state === authorization;
      return ready[0]?.state === authorization;
    },

    async hasPending(): Promise<boolean> {
      await Promise.resolve();
      if (failure !== undefined) throw failure.error;
      if (offeredRead !== undefined && !offeredRead.result.done) return true;
      if (ready.some((read) => !read.result.done)) return true;
      return states().some((state) => state.buffered.length > 0);
    },

    next: nextRead,

    async nextWithSource(): Promise<{
      result: IteratorResult<SessionInboxPayload>;
      source: SessionInboxSource;
    }> {
      const result = await nextRead();
      return {
        result,
        source:
          offeredRead !== undefined && offeredRead.state === authorization
            ? "authorization"
            : "session",
      };
    },

    setAuthorizationWindow(open: boolean): void {
      if (authorization === undefined) {
        if (open) {
          throw new Error("Cannot open the authorization window before claiming its hook.");
        }
        return;
      }
      if (open) {
        if (!authorization.enabled) enable(authorization);
        if (
          offeredRead !== undefined &&
          offeredRead.state !== authorization &&
          authorization.buffered[0] !== undefined &&
          authorization.buffered[0].order < offeredRead.order
        ) {
          enqueue(offeredRead);
          offeredRead = undefined;
          offered = null;
        }
        return;
      }
      authorization.enabled = false;
      // Un-surface a stashed read that was enqueued but not consumed so it
      // re-enqueues when the window reopens. Callers close the window only
      // after consuming any authorization read they were offered.
      for (let index = ready.length - 1; index >= 0; index--)
        if (ready[index]!.state === authorization) ready.splice(index, 1);
    },

    restore(payloads: readonly SessionInboxPayload[]): void {
      if (sessionHooks.length === 0) {
        throw new Error("Cannot restore session commands before reclaiming the session hooks.");
      }
      for (const value of payloads) {
        const read: HookRead = {
          order: nextOrder++,
          result: { done: false, value },
          state: sessionHooks[0]!,
        };
        read.state.buffered.push(read);
        enqueue(read);
      }
    },

    async release(): Promise<SessionInboxPayload[]> {
      const released = states();
      const accepted = new Set<HookRead>();
      const collect = () => {
        if (offeredRead !== undefined && !offeredRead.result.done) accepted.add(offeredRead);
        for (const read of ready) if (!read.result.done) accepted.add(read);
        for (const state of released) {
          for (const read of state.buffered) accepted.add(read);
        }
      };
      for (const state of released) state.stopping = true;
      for (const resolve of capacityWaiters) resolve();
      capacityWaiters.clear();
      await Promise.resolve();
      collect();
      await Promise.all(released.map(async (state) => await disposeHook(state.hook)));
      await Promise.resolve();
      collect();
      sessionHooks.splice(0, sessionHooks.length);
      authorization = undefined;
      ready.splice(0, ready.length);
      offered = null;
      offeredRead = undefined;
      wake?.();
      wake = undefined;
      return [...accepted]
        .sort((left, right) => left.order - right.order)
        .map((read) => read.result.value);
    },
  };
}
