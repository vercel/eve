import type { SessionPrewarmPayload } from "#execution/session-prewarm.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { createHook, getWorkflowMetadata, type Hook } from "#compiled/@workflow/core/index.js";
import { releaseSessionHooksStep } from "#execution/session-inbox/release-step.js";

import type { DeliverPayload, HookPayload, SessionCommand } from "#channel/types.js";
import {
  claimHookOwnership,
  disposeHook,
  isHookForceClaimedError,
} from "#execution/hook-ownership.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunMessageBatch,
} from "#execution/tools/workflow/messages.js";

/** All session addresses accept the same protocol. Callback routes construct
 * their own message kind; they never accept arbitrary session commands. */
export interface AuthorizationCallbackPayload {
  readonly kind: "authorization-callback";
  readonly payloads: DeliverPayload[];
}

/** The runtime sends this command; channel request bodies cannot supply it. */
export interface SessionFailurePayload {
  readonly kind: "session-failure";
  readonly error: string;
}

/**
 * One part of the previous owner's accepted-but-unread payloads after a
 * handoff. The runtime sends these commands; channel request bodies cannot
 * supply them.
 */
export interface SessionHandoverPayload {
  readonly kind: "handover";
  /** The handoff attempt this answers; see {@link SessionHookBatchClaimOptions.handover}. */
  readonly attemptKey: string;
  /** Parts apply in index order; a retried send repeats its index. */
  readonly index: number;
  /** The last part; reads resume once every part before it has been applied. */
  readonly final?: true;
  readonly payloads: readonly Exclude<SessionInboxPayload, SessionHandoverPayload>[];
}

export type SessionInboxPayload =
  | SessionPrewarmPayload
  | SessionFailurePayload
  | SessionHandoverPayload
  | HookPayload
  | SessionCommand
  | WorkflowToolRunMessage
  | AuthorizationCallbackPayload;

interface Source {
  readonly token: string;
  readonly hook: Hook<SessionInboxPayload | WorkflowToolRunMessageBatch>;
  registered?: Promise<void>;
  stopping: boolean;
  closed: boolean;
  /** A forced claim by this inbox took the token over from this source. */
  replaced: boolean;
}

/**
 * While a handover is awaited (see {@link SessionHookBatchClaimOptions.handover}),
 * reads expose nothing; interrupt handlers still fire on arrival.
 */
export interface SessionInboxReader {
  /**
   * Waits for and removes the next accepted payload in arrival order, or
   * `undefined` once no hook can deliver any more (released or taken over).
   * Only one consumer waits at a time; the owner program is strictly sequential.
   */
  next(): Promise<SessionInboxPayload | undefined>;
  /** Removes every payload accepted so far, in arrival order. */
  drain(): SessionInboxPayload[];
  /** Removes the payloads at the front of the queue that `accepts` takes, stopping at the first it doesn't. */
  takeLeading<T extends SessionInboxPayload>(
    accepts: (payload: SessionInboxPayload) => payload is T,
  ): T[];
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
  /**
   * Observes readable deliveries without consuming them; replays unread
   * deliveries on subscription and when a handover arrives, so handlers must
   * be idempotent.
   */
  onDelivery(handler: (payload: SessionInboxPayload) => void): () => void;
  /** Requeues payloads a successor handed back, ahead of everything pumped since. */
  restore(payloads: readonly SessionInboxPayload[]): void;
}

export interface SessionHookClaimOptions {
  /**
   * Take the address over from the run that holds it instead of conflicting.
   * Still rejects with `HookConflictError` when the holder's runtime cannot be
   * taken from; throws `FatalError` when the World does not support it. A
   * token this inbox already holds is claimed again on a fresh hook.
   */
  readonly force?: boolean;
  /**
   * Creates the hook at once but confirms its registration only after this
   * settles. While a registration is awaited, Workflow queues every step
   * started beside it instead of running it inline, so a claim made next to a
   * step confirms after that step; the hook still commits alongside it.
   */
  readonly confirmAfter?: Promise<unknown>;
}

export interface SessionHookBatchClaimOptions extends SessionHookClaimOptions {
  /**
   * Expect a `handover` for this attempt key. Before any hook is created,
   * reads stop exposing anything; as its parts arrive on any hook, their
   * payloads take their place after what was queued at this call and ahead of
   * everything accepted since. Reads resume after the final part.
   */
  readonly handover?: string;
}

export interface SessionInboxOwnership {
  /** Logical tokens currently claimed, in claim order. */
  readonly claimedTokens: readonly string[];
  claimSessionHook(token: string, options?: SessionHookClaimOptions): Promise<void>;
  /** Registers every token as one batch; all claims settle before the first failure propagates. */
  claimSessionHooks(
    tokens: readonly string[],
    options?: SessionHookBatchClaimOptions,
  ): Promise<void>;
}
export interface SessionInbox extends SessionInboxReader, SessionInboxOwnership {}
export interface SessionInboxHandle extends SessionInbox {
  /** A handover is expected and has not arrived; the session must not move again until it does. */
  readonly awaitingHandover: boolean;
  /** Resolves once no handover is awaited: it arrived, was abandoned, or the inbox closed. */
  whenHandoverSettled(): Promise<void>;
  /** Stops waiting for `attemptKey`'s handover, which can no longer arrive; queued payloads become readable. */
  abandonHandover(attemptKey: string): void;
  /** Resolves the first time a read waits on an awaited handover. */
  whenBlockedOnHandover(): Promise<void>;
  /** Resolves when the next payload arrives on any hook, readable or not. */
  whenArrival(): Promise<void>;
  /** Another run force-claimed every hook this inbox held. */
  readonly takenOver: boolean;
  /**
   * Resolves once another run has force-claimed every hook this inbox held.
   * Every payload delivered before the takeover is queued by then. Rejects if
   * a reader fails, if the inbox is released or disposed first, or once
   * `signal` aborts.
   */
  whenTakenOver(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
  /** Disposes every hook and returns each payload the hooks accepted but the owner never read. */
  release(): Promise<SessionInboxPayload[]>;
}

export function isInterrupt(value: SessionInboxPayload): boolean {
  return (
    value.kind === "cancel" ||
    value.kind === "reset" ||
    value.kind === "session-timeout" ||
    value.kind === "session-failure"
  );
}

function isDelivery(value: SessionInboxPayload): boolean {
  return value.kind === "send" || value.kind === "deliver";
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
  /**
   * `index` is where the next part's payloads go in `queue`; `parts` holds
   * parts that arrived ahead of `nextPart`.
   */
  let handover:
    | {
        readonly attemptKey: string;
        index: number;
        nextPart: number;
        readonly parts: Map<number, SessionHandoverPayload>;
      }
    | undefined;
  const blockedWaiters = new Set<() => void>();
  const arrivalWaiters = new Set<() => void>();
  let takenOver = false;
  let stopped = false;

  const notify = (): void => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const wait = (): Promise<void> => new Promise((resolve) => waiters.add(resolve));
  const closed = (): boolean => sources.every((source) => source.closed || source.stopping);
  // With no source left the handover can never arrive, so what is queued stays readable.
  const gated = (): boolean => handover !== undefined && sources.length > 0;
  const hasReadable = (): boolean => !gated() && queue.length > 0;
  const throwIfFailed = (): void => {
    if (failure !== undefined) throw failure.error;
  };
  const observe = (
    handlers: ReadonlySet<(payload: SessionInboxPayload) => void>,
    payloads: readonly SessionInboxPayload[],
    accepts: (payload: SessionInboxPayload) => boolean,
  ): void => {
    for (const payload of payloads)
      if (accepts(payload)) for (const handler of handlers) handler(payload);
  };

  const openHandover = (): void => {
    handover = undefined;
    // Deliveries held back while the handover was awaited were never observed.
    observe(deliveryHandlers, queue, isDelivery);
    notify();
  };
  const blockedOnHandover = (): void => {
    if (!gated()) return;
    for (const resolve of blockedWaiters) resolve();
    blockedWaiters.clear();
  };

  const acceptHandover = (part: SessionHandoverPayload): void => {
    // A retried send step repeats its own key and index, so any other key
    // belongs to an attempt this inbox is no longer waiting for.
    const current = handover;
    if (current === undefined || part.attemptKey !== current.attemptKey) return;
    if (part.index < current.nextPart || current.parts.has(part.index)) return;
    current.parts.set(part.index, part);
    const restored: SessionInboxPayload[] = [];
    while (true) {
      const next = current.parts.get(current.nextPart);
      if (next === undefined) break;
      if (next.final === true) {
        observe(interruptHandlers, restored, isInterrupt);
        openHandover();
        return;
      }
      current.parts.delete(current.nextPart);
      current.nextPart += 1;
      queue.splice(current.index, 0, ...next.payloads);
      current.index += next.payloads.length;
      restored.push(...next.payloads);
    }
    observe(interruptHandlers, restored, isInterrupt);
    notify();
  };

  // The SDK abandons (never settles) a read that is in flight when the hook
  // is disposed, so the loop exits on `stopping` rather than on `done`.
  const pump = async (source: Source): Promise<void> => {
    const iterator = source.hook[Symbol.asyncIterator]();
    try {
      while (!source.stopping) {
        const result = await iterator.next();
        if (result.done) break;
        const payload = result.value;
        for (const resolve of arrivalWaiters) resolve();
        arrivalWaiters.clear();
        if (payload.kind === "workflow-batch") {
          // A run's messages carry no deliveries or interrupts.
          queue.push(...payload.messages);
          notify();
          continue;
        }
        if (payload.kind === "handover") {
          acceptHandover(payload);
          continue;
        }
        queue.push(payload);
        if (!gated()) observe(deliveryHandlers, [payload], isDelivery);
        observe(interruptHandlers, [payload], isInterrupt);
        notify();
      }
    } catch (error) {
      // A replaced source's payloads accepted before the replacement are
      // already queued; its fresh hook carries on.
      if (source.stopping || source.replaced) return;
      // The SDK delivers every payload accepted before a takeover first, so
      // the queue already holds them; the address now belongs to another run.
      if (isHookForceClaimedError(error)) {
        sources.splice(sources.indexOf(source), 1);
        takenOver = true;
      } else {
        failure = { error };
      }
    } finally {
      source.closed = true;
      notify();
    }
  };

  const stop = async (): Promise<SessionInboxPayload[]> => {
    const released = sources.splice(0);
    handover = undefined;
    takenOver = false;
    stopped = true;
    for (const source of released) source.stopping = true;
    notify();
    await Promise.all(released.map(({ hook }) => disposeHook(hook)));
    const accepted = queue.splice(0);
    notify();
    return accepted;
  };

  const claimSessionHook = async (
    token: string,
    options: SessionHookClaimOptions = {},
  ): Promise<void> => {
    if (!token) throw new Error("A session alias requires a nonempty continuation token.");
    const force = options.force === true;
    const existing = sources.find((source) => source.token === token);
    if (existing !== undefined && !force) return await existing.registered;
    if (existing === undefined && sources.length >= 256)
      throw new Error("A session may claim at most 256 addresses.");
    const source: Source = {
      token,
      hook: createHook<SessionInboxPayload | WorkflowToolRunMessageBatch>({
        token: sessionInboxHookToken(token),
        metadata: { sessionId },
        ...(force && { experimental_force: true }),
      }),
      stopping: false,
      closed: false,
      replaced: false,
    };
    // Reserve the slot before awaiting registration: parallel claims retain
    // deterministic order and duplicate calls cannot create another hook.
    if (existing === undefined) {
      sources.push(source);
    } else {
      // Workflow lets a run take a token from its own earlier hook. This also
      // reclaims a token whose takeover the old pump has not observed yet.
      existing.replaced = true;
      sources.splice(sources.indexOf(existing), 1, source);
    }
    stopped = false;
    try {
      const confirm = () => claimHookOwnership(source.hook);
      source.registered = options.confirmAfter?.then(confirm, confirm) ?? confirm();
      await source.registered;
      // A takeover this run has reclaimed from no longer counts toward the next one.
      takenOver = false;
      void pump(source);
    } catch (error) {
      if (existing === undefined || existing.closed) {
        // A replaced source whose pump already returned can never deliver again.
        sources.splice(sources.indexOf(source), 1);
      } else {
        existing.replaced = false;
        sources.splice(sources.indexOf(source), 1, existing);
      }
      throw error;
    }
  };

  return {
    get claimedTokens() {
      return sources.map(({ token }) => token);
    },
    get awaitingHandover() {
      return handover !== undefined;
    },
    async whenHandoverSettled() {
      while (handover !== undefined) await wait();
    },
    abandonHandover(attemptKey) {
      if (handover?.attemptKey === attemptKey) openHandover();
    },
    whenBlockedOnHandover() {
      return new Promise((resolve) => blockedWaiters.add(resolve));
    },
    whenArrival() {
      return new Promise((resolve) => arrivalWaiters.add(resolve));
    },
    get takenOver() {
      return takenOver && sources.length === 0;
    },
    claimSessionHook,
    async claimSessionHooks(tokens, options = {}) {
      if (options.handover !== undefined)
        handover = {
          attemptKey: options.handover,
          index: queue.length,
          nextPart: 0,
          parts: new Map(),
        };
      const outcomes = await Promise.allSettled(
        [...new Set(tokens)].map((token) => claimSessionHook(token, options)),
      );
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    },
    async whenTakenOver(signal) {
      // Wakes the loop now rather than at the next arrival, so no waiter lingers.
      signal?.addEventListener("abort", notify, { once: true });
      while (sources.length > 0 || !takenOver) {
        throwIfFailed();
        if (stopped) throw new Error("The session inbox was released before a takeover.");
        if (signal?.aborted === true) throw signal.reason;
        await wait();
      }
    },
    async next() {
      while (true) {
        throwIfFailed();
        if (hasReadable()) return queue.shift();
        if (closed()) return undefined;
        blockedOnHandover();
        await wait();
      }
    },
    drain() {
      throwIfFailed();
      return gated() ? [] : queue.splice(0);
    },
    takeLeading<T extends SessionInboxPayload>(
      accepts: (payload: SessionInboxPayload) => payload is T,
    ): T[] {
      throwIfFailed();
      const taken: T[] = [];
      if (gated()) return taken;
      for (let next = queue[0]; next !== undefined && accepts(next); next = queue[0]) {
        taken.push(next);
        queue.shift();
      }
      return taken;
    },
    hasPending() {
      throwIfFailed();
      return hasReadable();
    },
    async whenPending() {
      while (failure === undefined && !hasReadable() && !closed()) {
        blockedOnHandover();
        await wait();
      }
    },
    onInterrupt(handler) {
      interruptHandlers.add(handler);
      return () => interruptHandlers.delete(handler);
    },
    onDelivery(handler) {
      deliveryHandlers.add(handler);
      if (!gated()) for (const payload of queue) if (isDelivery(payload)) handler(payload);
      return () => deliveryHandlers.delete(handler);
    },
    restore(payloads) {
      if (sources.length === 0)
        throw new Error("Cannot restore session commands before reclaiming the session hooks.");
      // Restored payloads were accepted before anything the reclaimed pumps
      // have enqueued since, so they must precede the current queue.
      queue.unshift(...payloads);
      if (handover !== undefined) handover.index += payloads.length;
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
