import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";

interface HookRead {
  readonly order: number;
  readonly result: IteratorResult<HookPayload>;
  readonly state: SessionDeliveryHookState;
}

interface SessionDeliveryHookState {
  readonly hook: Hook<HookPayload>;
  readonly iterator: AsyncIterator<HookPayload>;
  closed: boolean;
  enabled: boolean;
  pending: boolean;
  retired: boolean;
  resolved?: HookRead;
}

/** Reads and rekeys the public delivery hook for one session driver. */
export interface SessionDeliveryHook {
  consumeNext(): void;
  next(): Promise<IteratorResult<HookPayload>>;
  rekey(token: string): Promise<void>;
}

/** Adds workflow-entry lifecycle ownership to a session delivery hook. */
export interface SessionDeliveryHookHandle extends SessionDeliveryHook {
  dispose(): Promise<void>;
}

/**
 * Creates the public delivery hook used by `workflowEntry`.
 *
 * Retired hooks are disposed immediately, but their already-armed reads stay
 * in the logical hook's delivery race. A delivery that committed before disposal can
 * therefore still resolve on replay; a later delivery loses the storage race
 * to `hook_disposed` and receives `HookNotFoundError` from the Workflow SDK.
 */
export function createSessionDeliveryHook(
  bufferedDeliveries: DeliverHookPayload[],
): SessionDeliveryHookHandle {
  let active: SessionDeliveryHookState | undefined;
  const retired: SessionDeliveryHookState[] = [];
  const ready: HookRead[] = [];
  let nextOrder = 0;
  let offered: Promise<IteratorResult<HookPayload>> | null = null;
  let offeredRead: HookRead | undefined;
  let wake: (() => void) | undefined;

  const enqueue = (read: HookRead): void => {
    ready.push(read);
    ready.sort((left, right) => left.order - right.order);
    wake?.();
    wake = undefined;
  };

  const arm = (state: SessionDeliveryHookState): void => {
    if (state.closed || state.pending) return;

    state.pending = true;
    state.resolved = undefined;
    // A retired hook is disposed, so its iterator can no longer be advanced;
    // awaiting the hook itself surfaces the next payload that committed to the
    // token before disposal. `await hook` and the iterator share one delivery
    // cursor, so a payload already drained via the iterator is never re-yielded,
    // and once the committed payloads are exhausted the read rejects (swallowed
    // below) instead of resolving again. Re-arming a retired hook is therefore
    // safe: it cannot double-count or resurrect a delivery.
    const next = state.retired
      ? Promise.resolve(state.hook).then(
          (value): IteratorResult<HookPayload> => ({ done: false, value }),
        )
      : state.iterator.next();
    void next.then(
      (result) => {
        const read: HookRead = {
          order: nextOrder++,
          result,
          state,
        };
        state.resolved = read;
        if (state.enabled) enqueue(read);
      },
      () => {
        // `claimHookOwnership` owns candidate-claim errors, and an active hook
        // read cannot reject under the public delivery contract. A retired hook
        // read rejects once its committed payloads are exhausted; dropping it
        // here leaves the retired state quiescent (pending, never re-enqueued).
      },
    );
  };

  const enable = (state: SessionDeliveryHookState): void => {
    state.enabled = true;
    if (state.resolved !== undefined) enqueue(state.resolved);
  };

  const drainReady = async (): Promise<void> => {
    // A caller may already be racing this read against turn control. Leave
    // that promise intact: the losing race ignores it, and the next call to
    // `next()` reuses it without duplicating the delivery.
    if (offered !== null) return;

    await Promise.resolve();

    while (ready.length > 0) {
      const read = ready.shift()!;
      read.state.pending = false;
      read.state.resolved = undefined;

      if (read.result.done) {
        read.state.closed = true;
      } else if (read.result.value.kind === "deliver") {
        bufferedDeliveries.push(read.result.value);
      }

      arm(read.state);
      await Promise.resolve();
    }
  };

  return {
    consumeNext(): void {
      if (offeredRead === undefined) {
        throw new Error("Cannot consume a public delivery before it resolves.");
      }

      offeredRead.state.pending = false;
      offeredRead.state.resolved = undefined;
      if (offeredRead.result.done) offeredRead.state.closed = true;
      offeredRead = undefined;
      offered = null;
    },

    async dispose(): Promise<void> {
      if (active !== undefined) {
        await disposeHook(active.hook);
        active = undefined;
      }
    },

    next(): Promise<IteratorResult<HookPayload>> {
      if (active === undefined) {
        throw new Error("Cannot wait for deliveries before a continuation token is available.");
      }

      if (offered !== null) return offered;

      arm(active);
      for (const state of retired) arm(state);

      if (active.closed && retired.every((state) => state.closed)) {
        offeredRead = {
          order: nextOrder++,
          result: { done: true, value: undefined },
          state: active,
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

    async rekey(token: string): Promise<void> {
      if (!token || active?.hook.token === token) return;

      const candidateHook = createHook<HookPayload>({ token });
      const candidate: SessionDeliveryHookState = {
        closed: false,
        enabled: false,
        hook: candidateHook,
        iterator: candidateHook[Symbol.asyncIterator](),
        pending: false,
        retired: false,
      };

      if (active === undefined) {
        await claimHookOwnership(candidate.hook);
        enable(candidate);
        active = candidate;
        return;
      }

      const previous = active;
      arm(previous);
      arm(candidate);
      await claimHookOwnership(candidate.hook);
      enable(candidate);
      await drainReady();

      try {
        await disposeHook(previous.hook);
      } catch (error) {
        active = undefined;
        try {
          await disposeHook(candidate.hook);
        } catch {
          // The active hook release failure is authoritative.
        }
        throw error;
      }

      previous.retired = true;
      retired.push(previous);
      active = candidate;
      await drainReady();
    },
  };
}
