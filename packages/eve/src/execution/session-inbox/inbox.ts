import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";
import { releaseSessionHooksStep } from "#execution/session-inbox/release-step.js";

import type { DeliverPayload, HookPayload, SessionCommand } from "#channel/types.js";
import {
  claimHookOwnership,
  disposeHook,
  isHookForceClaimedError,
} from "#execution/hook-ownership.js";
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

interface Source {
  readonly token: string;
  readonly hook: Hook<SessionInboxPayload>;
  registered?: Promise<void>;
  stopping: boolean;
  closed: boolean;
}

export interface SessionInboxReader {
  /**
   * Waits for and removes the next accepted payload in arrival order, or
   * `undefined` once every hook is released. Only one consumer waits at a
   * time; the owner program is strictly sequential.
   */
  next(): Promise<SessionInboxPayload | undefined>;
  /** Removes every payload accepted so far, in arrival order. */
  drain(): SessionInboxPayload[];
  hasPending(): boolean;
  /**
   * Called from the pump the moment an interrupt (`cancel`, `reset`,
   * `session-timeout`) is accepted, ahead of any consumer read. Handlers must
   * be synchronous and idempotent. The payload stays in the queue so the
   * consumer still processes it in order.
   */
  onInterrupt(handler: (payload: SessionInboxPayload) => void): () => void;
  /** Observes deliveries without consuming them; replays unread deliveries on subscription. */
  onDelivery(handler: (payload: SessionInboxPayload) => void): () => void;
  restore(payloads: readonly SessionInboxPayload[]): void;
}

export interface SessionInboxOwnership {
  /** Logical tokens currently claimed, in claim order. */
  readonly claimedTokens: readonly string[];
  claimSessionHook(token: string): Promise<void>;
  /** Registers every token as one batch; all claims settle before the first failure propagates. */
  claimSessionHooks(tokens: readonly string[]): Promise<void>;
}
export interface SessionInbox extends SessionInboxReader, SessionInboxOwnership {}
export interface SessionInboxHandle extends SessionInbox {
  /**
   * Takes a token from whichever run holds it. The previous holder keeps what
   * its hook accepted first. Rejects when the World refuses the takeover.
   */
  claim(token: string): void;
  dispose(): Promise<void>;
  /** Disposes every hook and returns each payload the hooks accepted but the owner never read. */
  release(): Promise<SessionInboxPayload[]>;
}

export function isInterrupt(value: SessionInboxPayload): boolean {
  return value.kind === "cancel" || value.kind === "reset" || value.kind === "session-timeout";
}

/**
 * One FIFO queue for the session lifetime, fed by a continuous reader per
 * claimed hook. The pump never waits on queue depth: interrupts share each
 * hook's ordered stream, so any backpressure on ordinary payloads would also
 * hold back the cancel behind them. Accepted payloads are already durable on
 * the hook, so the queue is a mirror rather than the source of truth.
 */
export function createSessionInbox(sessionId: string): SessionInboxHandle {
  const sources: Source[] = [];
  const queue: SessionInboxPayload[] = [];
  const waiters = new Set<() => void>();
  const interruptHandlers = new Set<(payload: SessionInboxPayload) => void>();
  const deliveryHandlers = new Set<(payload: SessionInboxPayload) => void>();
  let failure: { error: unknown } | undefined;

  const notify = (): void => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const wait = (): Promise<void> => new Promise((resolve) => waiters.add(resolve));
  const closed = (): boolean => sources.every((source) => source.closed || source.stopping);

  // The SDK abandons (never settles) a read that is in flight when the hook
  // is disposed, so the loop exits on `stopping` rather than on `done`.
  const pump = async (source: Source): Promise<void> => {
    const iterator = source.hook[Symbol.asyncIterator]();
    try {
      while (!source.stopping) {
        const result = await iterator.next();
        if (result.done) break;
        queue.push(result.value);
        if (result.value.kind === "send" || result.value.kind === "deliver")
          for (const handler of deliveryHandlers) handler(result.value);
        if (isInterrupt(result.value))
          for (const handler of interruptHandlers) handler(result.value);
        notify();
      }
    } catch (error) {
      // A forced claim ends a reader only after it delivered everything its
      // hook accepted; from then on the claiming run answers the token.
      if (!source.stopping && !isHookForceClaimedError(error)) failure = { error };
    } finally {
      source.closed = true;
      notify();
    }
  };

  const stop = async (): Promise<SessionInboxPayload[]> => {
    const released = sources.splice(0);
    for (const source of released) source.stopping = true;
    notify();
    await Promise.all(released.map(({ hook }) => disposeHook(hook)));
    const accepted = queue.splice(0);
    notify();
    return accepted;
  };

  const claimSessionHook = async (token: string): Promise<void> => {
    if (!token) throw new Error("A session alias requires a nonempty continuation token.");
    const existing = sources.find((source) => source.token === token);
    if (existing !== undefined) return await existing.registered;
    if (sources.length >= 256) throw new Error("A session may claim at most 256 addresses.");
    const source: Source = {
      token,
      hook: createHook<SessionInboxPayload>({
        token: sessionInboxHookToken(token),
        metadata: { sessionId },
      }),
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
  };

  return {
    get claimedTokens() {
      return sources.map(({ token }) => token);
    },
    claimSessionHook,
    async claimSessionHooks(tokens) {
      const outcomes = await Promise.allSettled([...new Set(tokens)].map(claimSessionHook));
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    },
    claim(token) {
      const source: Source = {
        token,
        hook: createHook<SessionInboxPayload>({
          token: sessionInboxHookToken(token),
          metadata: { sessionId },
          experimental_force: true,
        }),
        stopping: false,
        closed: false,
      };
      sources.push(source);
      void pump(source);
    },
    async next() {
      while (true) {
        if (failure !== undefined) throw failure.error;
        if (queue.length > 0) return queue.shift();
        if (closed()) return undefined;
        await wait();
      }
    },
    drain() {
      if (failure !== undefined) throw failure.error;
      return queue.splice(0);
    },
    hasPending() {
      if (failure !== undefined) throw failure.error;
      return queue.length > 0;
    },
    onInterrupt(handler) {
      interruptHandlers.add(handler);
      return () => interruptHandlers.delete(handler);
    },
    onDelivery(handler) {
      deliveryHandlers.add(handler);
      for (const payload of queue)
        if (payload.kind === "send" || payload.kind === "deliver") handler(payload);
      return () => deliveryHandlers.delete(handler);
    },
    restore(payloads) {
      if (sources.length === 0)
        throw new Error("Cannot restore session commands before reclaiming the session hooks.");
      // Restored payloads were accepted before anything the reclaimed pumps
      // have enqueued since, so they must precede the current queue.
      queue.unshift(...payloads);
      notify();
    },
    async dispose() {
      // Accepted-but-unread payloads are dropped: disposal ends the session.
      await stop();
    },
    async release() {
      // Commit disposal durably before the readers stop: the SDK delivers every
      // hook event accepted before that commit to the iterators first, so the
      // queue holds each accepted payload when `stop()` drains it.
      if (sources.length > 0) {
        await releaseSessionHooksStep({
          ownerRunId: getWorkflowMetadata().workflowRunId,
          tokens: sources.map(({ hook }) => hook.token),
        });
      }
      return await stop();
    },
  };
}

export function isWorkflowMessage(value: SessionInboxPayload): value is WorkflowToolRunMessage {
  return value.kind === "report" || value.kind === "request" || value.kind === "outcome";
}
