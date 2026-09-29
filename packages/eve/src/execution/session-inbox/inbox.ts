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
  /** Another run took the token with a forced claim during an expected takeover. */
  taken: boolean;
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
  /** Resolves once a payload is ready or the inbox closes, without consuming anything. */
  whenPending(): Promise<void>;
  /**
   * Called from the pump the moment an interrupt (`cancel`, `reset`,
   * `session-timeout`) is accepted, ahead of any consumer read. Handlers must
   * be synchronous and idempotent. The payload stays in the queue so the
   * consumer still processes it in order.
   */
  onInterrupt(handler: (payload: SessionInboxPayload) => void): () => void;
  /** Observes deliveries without consuming them; replays unread deliveries on subscription. */
  onDelivery(handler: (payload: SessionInboxPayload) => void): () => void;
  /**
   * Observes runs' `agent-started` messages without consuming them; replays
   * unread ones on subscription. Handlers must be synchronous.
   */
  onAgentStarted(handler: (message: WorkflowToolRunAgentStarted) => void): () => void;
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
   * Takes every token from whichever run holds it; the previous holder keeps
   * what its hook accepted first. A token this inbox lost to a takeover is
   * taken back. Every claim settles before the first refusal propagates.
   */
  claim(tokens: readonly string[]): Promise<void>;
  /**
   * Lets another run take these hooks. A forced claim at any other time fails
   * the owner rather than reading as a session with no more input.
   */
  allowTakeover(allowed: boolean): void;
  /** Tokens another run took while a takeover was allowed, in claim order. */
  readonly takenTokens: readonly string[];
  /** Queues payloads after everything this inbox has accepted so far. */
  enqueue(payloads: readonly SessionInboxPayload[]): void;
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
  const agentStartedHandlers = new Set<(message: WorkflowToolRunAgentStarted) => void>();
  let failure: { error: unknown } | undefined;
  let takeoverAllowed = false;

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
        if (isAgentStarted(result.value))
          for (const handler of agentStartedHandlers) handler(result.value);
        notify();
      }
    } catch (error) {
      // A forced claim ends a reader only after it delivered everything its
      // hook accepted; from then on the claiming run answers the token.
      if (source.stopping) return;
      if (takeoverAllowed && isHookForceClaimedError(error)) source.taken = true;
      else failure = { error };
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

  const requireToken = (token: string): void => {
    if (!token) throw new Error("A session alias requires a nonempty continuation token.");
  };
  const requireCapacity = (added: number): void => {
    if (sources.length + added > 256) throw new Error("A session may claim at most 256 addresses.");
  };

  // The slot is reserved before registration settles: parallel claims retain
  // deterministic order and duplicate calls cannot create another hook.
  const register = async (token: string, options: { readonly force: boolean }): Promise<void> => {
    const source: Source = {
      token,
      hook: createHook<SessionInboxPayload>({
        token: sessionInboxHookToken(token),
        metadata: { sessionId },
        experimental_force: options.force ? true : undefined,
      }),
      stopping: false,
      closed: false,
      taken: false,
    };
    const index = sources.findIndex((existing) => existing.token === token);
    if (index === -1) sources.push(source);
    else sources[index] = source;
    try {
      source.registered = claimHookOwnership(source.hook);
      await source.registered;
      void pump(source);
    } catch (error) {
      sources.splice(sources.indexOf(source), 1);
      throw error;
    }
  };

  const claimSessionHook = async (token: string): Promise<void> => {
    requireToken(token);
    const existing = sources.find((source) => source.token === token);
    if (existing !== undefined) return await existing.registered;
    requireCapacity(1);
    await register(token, { force: false });
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
    async claim(tokens) {
      const unique = [...new Set(tokens)];
      for (const token of unique) {
        requireToken(token);
        if (sources.some((source) => source.token === token && !source.taken))
          throw new Error(`Session address "${token}" is already claimed.`);
      }
      requireCapacity(
        unique.filter((token) => !sources.some((source) => source.token === token)).length,
      );
      const outcomes = await Promise.allSettled(
        unique.map((token) => register(token, { force: true })),
      );
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    },
    allowTakeover(allowed) {
      takeoverAllowed = allowed;
    },
    get takenTokens() {
      return sources.filter((source) => source.taken).map(({ token }) => token);
    },
    enqueue(payloads) {
      queue.push(...payloads);
      notify();
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
    async whenPending() {
      while (failure === undefined && queue.length === 0 && !closed()) await wait();
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
    onAgentStarted(handler) {
      agentStartedHandlers.add(handler);
      for (const payload of queue) if (isAgentStarted(payload)) handler(payload);
      return () => agentStartedHandlers.delete(handler);
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

/** A run's report that it opened a session, which the session publishes as `agent.started`. */
export type WorkflowToolRunAgentStarted = Extract<
  WorkflowToolRunMessage,
  { readonly kind: "agent-started" }
>;

function isAgentStarted(value: SessionInboxPayload): value is WorkflowToolRunAgentStarted {
  return value.kind === "agent-started";
}

export function isWorkflowMessage(value: SessionInboxPayload): value is WorkflowToolRunMessage {
  return (
    value.kind === "agent-started" ||
    value.kind === "started" ||
    value.kind === "report" ||
    value.kind === "reply" ||
    value.kind === "request" ||
    value.kind === "withdraw" ||
    value.kind === "usage" ||
    value.kind === "outcome"
  );
}
