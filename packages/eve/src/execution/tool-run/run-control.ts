import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import { isRunControlMessage, type RunControlMessage } from "#execution/tool-run/messages.js";

/**
 * A run's control surface: the hook that is both its identity claim and the
 * inbox its owner cancels it on, a durable `AbortController` a `cancel` message
 * trips, and a `cancelled` promise the body's waits race so the durable read is
 * actually driven. Racing is what makes cancellation observable — an unawaited
 * hook read is not scheduled under replay — so every eve-provided wait races
 * `cancelled`, and the signal is there for steps and manual races.
 */
export interface RunControlInbox {
  readonly hook: Hook<RunControlMessage>;
  readonly signal: AbortSignal;
  /** Rejects with {@link RunCancelledError} when a cancel message arrives; never resolves. */
  readonly cancelled: Promise<never>;
  /** The cancel reason once aborted, for the run's `cancelled` outcome. */
  reason(): string | undefined;
}

/**
 * Opens (does not claim) the run's control inbox. Claiming stays with the
 * caller so a losing duplicate start never trips the signal. The abort fires
 * inside the read continuation so a same-drain observer sees it immediately.
 */
export function openRunControlInbox(hookToken: string): RunControlInbox {
  const hook = createHook<RunControlMessage>({ token: hookToken });
  // Hook promises and iterators share one durable cursor. Create the iterator
  // before the caller claims so conflict replay is consumed by getConflict().
  const iterator = hook[Symbol.asyncIterator]();
  const controller = new AbortController();
  let cancelReason: string | undefined;

  const cancelled = consumeCancel(iterator, (reason) => {
    cancelReason = reason;
    controller.abort(new RunCancelledError(reason));
  });
  // Racing drives the read; a lone reference must not surface as unhandled.
  cancelled.catch(() => {});

  return {
    cancelled,
    hook,
    reason: () => cancelReason,
    signal: controller.signal,
  };
}

/**
 * Reads the control inbox until a cancel message, aborting in the read
 * continuation and then rejecting so a racing wait throws. A non-cancel or
 * malformed message is skipped; end-of-stream parks forever so the race is
 * simply never won.
 */
async function consumeCancel(
  iterator: AsyncIterator<RunControlMessage>,
  onCancel: (reason: string) => void,
): Promise<never> {
  while (true) {
    let next: IteratorResult<RunControlMessage>;
    try {
      next = await iterator.next();
    } catch {
      return await new Promise<never>(() => {});
    }
    if (next.done === true) return await new Promise<never>(() => {});
    if (!isRunControlMessage(next.value)) continue;
    onCancel(next.value.reason);
    throw new RunCancelledError(next.value.reason);
  }
}

/** The reason a workflow tool body's awaits reject with when the run is cancelled. */
export class RunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunCancelledError";
  }
}
