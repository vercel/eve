import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import { isRunControlMessage, type RunControlMessage } from "#execution/tool-run/messages.js";

/**
 * The run's control inbox. An unawaited hook read is not scheduled under
 * replay, so `cancelled` must be raced for a cancel to be observed at all.
 */
export interface RunControlInbox {
  readonly hook: Hook<RunControlMessage>;
  readonly signal: AbortSignal;
  /** Rejects with {@link RunCancelledError} when a cancel message arrives; never resolves. */
  readonly cancelled: Promise<never>;
  reason(): string | undefined;
}

/** Opens without claiming, so a losing duplicate start never trips the signal. */
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

// End-of-stream parks forever so the race is simply never won.
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

export class RunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunCancelledError";
  }
}
