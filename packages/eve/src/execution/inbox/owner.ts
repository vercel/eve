import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import type { InboxAddress, InboxEnvelope, OwnerInbox } from "#execution/inbox/types.js";

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

export class InboxClosedError extends Error {
  constructor(token: string) {
    super(`Owner inbox "${token}" is closed.`);
    this.name = "InboxClosedError";
  }
}

export function createOwnerInbox<T extends InboxEnvelope = InboxEnvelope>(input: {
  readonly token: string;
  readonly ownerRunId?: string;
}): OwnerInbox<T> {
  const address = {
    ownerRunId: input.ownerRunId ?? getWorkflowMetadata().workflowRunId,
    token: input.token,
  };
  const hook = createHook<T>({ token: address.token });
  return ownerInboxFromHook(address, hook);
}

/** One reader owns the durable cursor for the whole claim, including overlapping asks. */
export function ownerInboxFromHook<T extends InboxEnvelope>(
  address: InboxAddress,
  hook: AsyncIterable<T> & {
    getConflict(): Promise<{ readonly runId: string } | null>;
    dispose(): void;
  },
): OwnerInbox<T> {
  const iterator = hook[Symbol.asyncIterator]();
  const buffered: T[] = [];
  const waiters: Waiter<T>[] = [];
  const replies = new Map<string, T[]>();
  const replyWaiters = new Map<string, Waiter<T>[]>();
  const observers = new Set<(envelope: T) => void>();
  const errorObservers = new Set<(error: unknown) => void>();
  let closed: { error: unknown } | undefined;
  let claimed = false;
  let pendingCount = 0;
  const seen = new Set<string>();
  const MAX_PENDING = 1024;
  let pump: Promise<void> | undefined;

  function close(error: unknown): void {
    if (closed !== undefined) return;
    closed = { error };
    for (const observer of errorObservers) observer(error);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    for (const waiting of replyWaiters.values()) {
      for (const waiter of waiting) waiter.reject(error);
    }
    replyWaiters.clear();
  }

  async function read(): Promise<void> {
    try {
      while (closed === undefined) {
        const next = await iterator.next();
        if (next.done === true) {
          close(new InboxClosedError(address.token));
          return;
        }
        const envelope = next.value;
        if (
          typeof envelope.eventId !== "string" ||
          envelope.eventId.length === 0 ||
          typeof envelope.kind !== "string"
        ) {
          throw new TypeError("An owner inbox event requires an eventId and discriminated kind.");
        }
        if (envelope.target !== undefined && envelope.target.ownerRunId !== address.ownerRunId)
          continue;
        if (seen.has(envelope.eventId)) continue;
        seen.add(envelope.eventId);
        if (seen.size > 4096) seen.delete(seen.values().next().value!);
        for (const observer of observers) observer(envelope);
        if (envelope.requestId !== undefined && envelope.kind.endsWith(".response")) {
          const waiting = replyWaiters.get(envelope.requestId)?.shift();
          if (replyWaiters.get(envelope.requestId)?.length === 0)
            replyWaiters.delete(envelope.requestId);
          if (waiting !== undefined) waiting.resolve(envelope);
          else {
            if (++pendingCount > MAX_PENDING)
              throw new Error("Owner inbox buffer capacity exceeded.");
            const queue = replies.get(envelope.requestId) ?? [];
            queue.push(envelope);
            replies.set(envelope.requestId, queue);
          }
        } else {
          const waiting = waiters.shift();
          if (waiting !== undefined) waiting.resolve(envelope);
          else {
            if (++pendingCount > MAX_PENDING)
              throw new Error("Owner inbox buffer capacity exceeded.");
            buffered.push(envelope);
          }
        }
      }
    } catch (error) {
      close(error);
    }
  }

  function drive(): void {
    pump ??= read();
  }

  function throwIfClosed(): void {
    if (closed !== undefined) throw closed.error;
  }

  async function wait(queue: Waiter<T>[], signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    throwIfClosed();
    drive();
    throwIfClosed();
    if (
      waiters.length +
        [...replyWaiters.values()].reduce((count, waiting) => count + waiting.length, 0) >=
      128
    ) {
      throw new Error("Owner inbox waiter capacity exceeded.");
    }
    let waiter: Waiter<T>;
    const abort = (): void => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      waiter.reject(signal!.reason);
    };
    try {
      return await new Promise<T>((resolve, reject) => {
        waiter = { reject, resolve };
        queue.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    address,
    async claim() {
      if (claimed) throw new Error("An owner inbox represents exactly one claim attempt.");
      claimed = true;
      drive();
      const conflict = await hook.getConflict();
      if (conflict !== null) return { kind: "conflict", runId: conflict.runId };
      return { kind: "owned" };
    },
    drain() {
      if (closed !== undefined) throw closed.error;
      const drained = buffered.splice(0);
      pendingCount -= drained.length;
      return drained;
    },
    async next() {
      const ready = buffered.shift();
      if (ready !== undefined) {
        pendingCount--;
        return ready;
      }
      return await wait(waiters);
    },
    async response(requestId, signal) {
      signal?.throwIfAborted();
      const ready = replies.get(requestId)?.shift();
      if (replies.get(requestId)?.length === 0) replies.delete(requestId);
      if (ready !== undefined) {
        pendingCount--;
        return ready;
      }
      const queue = replyWaiters.get(requestId) ?? [];
      replyWaiters.set(requestId, queue);
      try {
        return await wait(queue, signal);
      } finally {
        if (replyWaiters.get(requestId)?.length === 0) replyWaiters.delete(requestId);
      }
    },
    observe(listener, onError) {
      observers.add(listener);
      if (onError !== undefined) {
        errorObservers.add(onError);
        if (closed !== undefined) onError(closed.error);
      }
      return () => {
        observers.delete(listener);
        if (onError !== undefined) errorObservers.delete(onError);
      };
    },
    async dispose() {
      close(new InboxClosedError(address.token));
      observers.clear();
      errorObservers.clear();
      buffered.length = 0;
      replies.clear();
      hook.dispose();
    },
  };
}
