import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { bundledEveVersion } from "#internal/package-version.js";

/**
 * Payloads accepted by a session driver's stable and channel aliases.
 *
 * `DeliverHookPayload` is the only delivery format producers persist. The
 * `send` member of `SessionCommand` stays accepted solely for payloads
 * persisted by eve 0.30.3–0.30.8, which wrote the command shape directly;
 * sessions are bounded by the 30-day default timeout, so the decode can be
 * dropped once runs created on those versions have aged out.
 */
export type SessionInboxPayload = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;

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
  retired: boolean;
  resolved?: HookRead;
}

/** Multiplexes one stable session hook and one rekeyable channel alias. */
export interface SessionCommandInbox {
  claimStable(token: string): Promise<void>;
  consumeNext(): void;
  next(): Promise<IteratorResult<SessionInboxPayload>>;
  rekeyContinuation(token: string): Promise<void>;
}

/** Adds workflow-entry lifecycle ownership to a session command inbox. */
export interface SessionCommandInboxHandle extends SessionCommandInbox {
  dispose(): Promise<void>;
}

/**
 * Creates the command inbox owned by one session driver.
 *
 * The stable hook is retained for the session's lifetime. Rekeying replaces
 * only the channel alias. Reads already committed to a retired alias remain in
 * the multiplexed queue and are consumed exactly once.
 */
export function createSessionCommandInbox(): SessionCommandInboxHandle {
  let stable: SessionCommandHookState | undefined;
  let continuation: SessionCommandHookState | undefined;
  const retired: SessionCommandHookState[] = [];
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
    const next = state.retired
      ? Promise.resolve(state.hook).then(
          (value): IteratorResult<SessionInboxPayload> => ({ done: false, value }),
        )
      : state.iterator.next();
    void next.then(
      (result) => {
        const read: HookRead = { order: nextOrder++, result, state };
        state.resolved = read;
        if (state.enabled) enqueue(read);
      },
      () => {
        // Retired hooks reject after their committed payloads are exhausted.
      },
    );
  };

  const enable = (state: SessionCommandHookState): void => {
    state.enabled = true;
    if (state.resolved !== undefined) enqueue(state.resolved);
  };

  const createState = (token: string): SessionCommandHookState => {
    // Stamp the consumer's eve version so producers can read it pre-resume
    // (`getHookByToken(...).metadata`) and version-gate future wire changes.
    // Hooks created before this stamp carry no metadata: markerless means
    // the consumer predates it and only understands the legacy shapes.
    const hook = createHook<SessionInboxPayload>({
      metadata: { eveVersion: bundledEveVersion() },
      token,
    });
    return {
      closed: false,
      enabled: false,
      hook,
      iterator: hook[Symbol.asyncIterator](),
      pending: false,
      retired: false,
    };
  };

  const states = (): readonly SessionCommandHookState[] =>
    [stable, continuation, ...retired].filter(
      (state): state is SessionCommandHookState => state !== undefined,
    );

  return {
    async claimStable(token: string): Promise<void> {
      if (stable !== undefined) {
        if (stable.hook.token === token) return;
        throw new Error("A session command inbox cannot change its stable token.");
      }

      const candidate = createState(token);
      await claimHookOwnership(candidate.hook);
      enable(candidate);
      stable = candidate;
    },

    consumeNext(): void {
      if (offeredRead === undefined) {
        throw new Error("Cannot consume a session command before it resolves.");
      }

      offeredRead.state.pending = false;
      offeredRead.state.resolved = undefined;
      if (offeredRead.result.done) offeredRead.state.closed = true;
      offeredRead = undefined;
      offered = null;
    },

    async dispose(): Promise<void> {
      const active = [continuation, stable].filter(
        (state): state is SessionCommandHookState => state !== undefined,
      );
      continuation = undefined;
      stable = undefined;
      await Promise.all(active.map(async (state) => await disposeHook(state.hook)));
    },

    next(): Promise<IteratorResult<SessionInboxPayload>> {
      if (stable === undefined) {
        throw new Error("Cannot wait for session commands before claiming the stable inbox.");
      }

      if (offered !== null) return offered;

      const current = states();
      for (const state of current) arm(state);

      if (current.every((state) => state.closed)) {
        offeredRead = {
          order: nextOrder++,
          result: { done: true, value: undefined },
          state: stable,
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
    },

    async rekeyContinuation(token: string): Promise<void> {
      if (!token || continuation?.hook.token === token) return;

      const candidate = createState(token);
      if (continuation === undefined) {
        await claimHookOwnership(candidate.hook);
        enable(candidate);
        continuation = candidate;
        if (offered !== null) arm(candidate);
        return;
      }

      arm(candidate);
      await claimHookOwnership(candidate.hook);
      enable(candidate);

      const previous = continuation;
      continuation = candidate;
      arm(previous);
      try {
        await disposeHook(previous.hook);
      } catch (error) {
        continuation = undefined;
        try {
          await disposeHook(candidate.hook);
        } catch {
          // The previous-alias release failure is authoritative.
        }
        throw error;
      }

      previous.retired = true;
      retired.push(previous);
    },
  };
}
