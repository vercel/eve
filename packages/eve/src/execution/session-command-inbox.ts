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
  pending: boolean;
  resolved?: HookRead;
}

/** Which hook family produced an inbox read. */
export type SessionInboxSource = "authorization" | "session";

/**
 * Multiplexes an additive set of session-address hooks and one window-gated
 * authorization-callback hook. The stable session inbox is the first session
 * hook; every continuation rekey adds another hook without retiring an older
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
 * source keeps one pending iterator read so deliveries through any historical
 * continuation address join the same ordered queue exactly once.
 */
export function createSessionCommandInbox(sessionId: string): SessionCommandInboxHandle {
  const sessionHooks: SessionCommandHookState[] = [];
  let authorization: SessionCommandHookState | undefined;
  const ready: HookRead[] = [];
  let nextOrder = 0;
  let offered: Promise<IteratorResult<SessionInboxPayload>> | null = null;
  let offeredRead: HookRead | undefined;
  let wake: (() => void) | undefined;
  const enqueue = (read: HookRead): void => {
    ready.push(read);
    ready.sort((left, right) => left.order - right.order);
    wake?.();
    wake = undefined;
  };

  const arm = (state: SessionCommandHookState): void => {
    if (state.closed || state.pending) return;

    state.pending = true;
    state.resolved = undefined;
    const next = state.iterator.next();
    void next.then(
      (result) => {
        const read: HookRead = { order: nextOrder++, result, state };
        state.resolved = read;
        if (state.enabled) enqueue(read);
      },
      () => {
        // Hook disposal rejects any iterator read that did not commit a payload.
      },
    );
  };

  const enable = (state: SessionCommandHookState): void => {
    state.enabled = true;
    if (state.resolved !== undefined) enqueue(state.resolved);
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
      pending: false,
    };
  };

  const states = (): readonly SessionCommandHookState[] =>
    authorization === undefined ? sessionHooks : [...sessionHooks, authorization];

  const nextRead = (): Promise<IteratorResult<SessionInboxPayload>> => {
    if (sessionHooks.length === 0) {
      throw new Error("Cannot wait for session commands before claiming a session hook.");
    }

    if (offered !== null) return offered;

    const current = states();
    for (const state of current) arm(state);

    if (current.every((state) => state.closed)) {
      offeredRead = {
        order: nextOrder++,
        result: { done: true, value: undefined },
        state: sessionHooks[0]!,
      };
      offered = Promise.resolve(offeredRead.result);
      return offered;
    }

    offered = (async () => {
      while (ready.length === 0) {
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
      if (authorization !== undefined) {
        if (authorization.hook.token === token) return;
        throw new Error("A session command inbox cannot change its authorization token.");
      }

      const candidate = createState(token);
      await claimHookOwnership(candidate.hook);
      // Stays disabled until the owner opens the authorization window;
      // resolved reads stash on the state and enqueue when it opens.
      authorization = candidate;
      arm(candidate);
    },

    async claimSessionHook(token: string): Promise<void> {
      if (!token || sessionHooks.some((state) => state.hook.token === token)) return;

      const candidate = createState(token);
      await claimHookOwnership(candidate.hook);
      sessionHooks.push(candidate);
      enable(candidate);
      arm(candidate);
    },

    consumeNext(): void {
      if (offeredRead === undefined) {
        throw new Error("Cannot consume a session command before it resolves.");
      }

      const consumed = offeredRead;
      consumed.state.pending = false;
      consumed.state.resolved = undefined;
      if (consumed.result.done) consumed.state.closed = true;
      offeredRead = undefined;
      offered = null;
      if (!consumed.result.done) arm(consumed.state);
    },

    async dispose(): Promise<void> {
      await this.release();
    },

    hasReadyAuthorization(): boolean {
      if (authorization?.enabled !== true || authorization.resolved === undefined) return false;
      if (offeredRead !== undefined) return offeredRead.state === authorization;
      return ready[0]?.state === authorization;
    },

    async hasPending(): Promise<boolean> {
      for (const state of states()) arm(state);
      await Promise.resolve();
      if (offeredRead !== undefined && !offeredRead.result.done) return true;
      if (ready.some((read) => !read.result.done)) return true;
      return states().some((state) => state.resolved !== undefined && !state.resolved.result.done);
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
          authorization.resolved !== undefined &&
          authorization.resolved.order < offeredRead.order
        ) {
          enqueue(offeredRead);
          offeredRead = undefined;
          offered = null;
        }
        if (offered !== null) arm(authorization);
        return;
      }
      authorization.enabled = false;
      // Un-surface a stashed read that was enqueued but not consumed so it
      // re-enqueues when the window reopens. Callers close the window only
      // after consuming any authorization read they were offered.
      const enqueued = ready.findIndex((read) => read.state === authorization);
      if (enqueued !== -1) ready.splice(enqueued, 1);
    },

    restore(payloads: readonly SessionInboxPayload[]): void {
      if (sessionHooks.length === 0) {
        throw new Error("Cannot restore session commands before reclaiming the session hooks.");
      }
      for (const value of payloads) {
        enqueue({
          order: nextOrder++,
          result: { done: false, value },
          state: sessionHooks[0]!,
        });
      }
    },

    async release(): Promise<SessionInboxPayload[]> {
      const released = states();
      const active =
        authorization === undefined ? [...sessionHooks] : [...sessionHooks, authorization];
      const accepted = new Set<HookRead>();
      const collect = () => {
        if (offeredRead !== undefined && !offeredRead.result.done) accepted.add(offeredRead);
        for (const read of ready) if (!read.result.done) accepted.add(read);
        for (const state of released) {
          if (state.resolved !== undefined && !state.resolved.result.done)
            accepted.add(state.resolved);
        }
      };
      for (const state of released) arm(state);
      await Promise.resolve();
      collect();
      await Promise.all(active.map(async (state) => await disposeHook(state.hook)));
      await Promise.resolve();
      collect();
      sessionHooks.splice(0, sessionHooks.length);
      authorization = undefined;
      ready.splice(0, ready.length);
      offered = null;
      offeredRead = undefined;
      wake = undefined;
      return [...accepted]
        .sort((left, right) => left.order - right.order)
        .map((read) => read.result.value);
    },
  };
}
