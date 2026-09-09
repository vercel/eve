import { createHook } from "#compiled/@workflow/core/index.js";

import {
  isWorkflowToolRunControlMessage,
  type WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";

/**
 * The run's control inbox. An unawaited hook read is not scheduled under
 * replay, so `cancelled` must be raced for a cancel to be observed at all.
 */
export interface WorkflowToolRunControlInbox {
  readonly signal: AbortSignal;
  /** Rejects with {@link WorkflowToolRunCancelledError} when a cancel message arrives; never resolves. */
  readonly cancelled: Promise<never>;
  reason(): string | undefined;
}

export function openWorkflowToolRunControlInbox(hookToken: string): WorkflowToolRunControlInbox {
  const hook = createHook<WorkflowToolRunControlMessage>({ token: hookToken });
  const iterator = hook[Symbol.asyncIterator]();
  const controller = new AbortController();
  let cancelReason: string | undefined;

  const cancelled = consumeCancel(iterator, (reason) => {
    cancelReason = reason;
    controller.abort(new WorkflowToolRunCancelledError(reason));
  });
  // Racing drives the read; a lone reference must not surface as unhandled.
  cancelled.catch(() => {});

  return {
    cancelled,
    reason: () => cancelReason,
    signal: controller.signal,
  };
}

// End-of-stream parks forever so the race is simply never won.
async function consumeCancel(
  iterator: AsyncIterator<WorkflowToolRunControlMessage>,
  onCancel: (reason: string) => void,
): Promise<never> {
  while (true) {
    const next = await iterator.next();
    if (next.done === true) return await new Promise<never>(() => {});
    if (!isWorkflowToolRunControlMessage(next.value)) continue;
    onCancel(next.value.reason);
    throw new WorkflowToolRunCancelledError(next.value.reason);
  }
}

export class WorkflowToolRunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorkflowToolRunCancelledError";
  }
}
