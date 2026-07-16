import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";

/** Owns one replay-safe durable hook read at a time for an active turn. */
export interface TurnHookInbox<T> {
  readonly token: string;
  next(): Promise<T>;
  dispose(): Promise<void>;
}

export async function createTurnHookInbox<T>(input: {
  readonly conflict: "throw";
  readonly token: string;
}): Promise<TurnHookInbox<T>>;
export async function createTurnHookInbox<T>(input: {
  readonly conflict: "return-undefined";
  readonly token: string;
}): Promise<TurnHookInbox<T> | undefined>;
export async function createTurnHookInbox<T>(input: {
  readonly conflict: "return-undefined" | "throw";
  readonly token: string;
}): Promise<TurnHookInbox<T> | undefined> {
  const hook = createHook<T>({ token: input.token });
  // Hook promises and iterators share one durable cursor. Create the iterator
  // before claiming so conflict replay is consumed by getConflict(), not by a
  // later data read.
  const iterator = hook[Symbol.asyncIterator]();

  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (input.conflict === "return-undefined" && isHookConflictError(error)) {
      return undefined;
    }
    throw error;
  }

  let disposed = false;
  let pending: Promise<T> | undefined;

  return {
    token: hook.token,
    next(): Promise<T> {
      pending ??= iterator.next().then((result) => {
        pending = undefined;
        if (result.done) return new Promise<never>(() => {});
        return result.value;
      });
      // Losing Promise.race arms may be abandoned during turn teardown.
      pending.catch(() => {});
      return pending;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Never call iterator.return(): it waits for a pending durable read and
      // can leave the workflow run alive indefinitely.
      await disposeHook(hook);
    },
  };
}
