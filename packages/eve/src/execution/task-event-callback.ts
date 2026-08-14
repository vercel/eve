import type { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { fireTaskEventCallbackStep } from "#execution/session-callback-step.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/**
 * Forwards one task child's blocking transition to its parent's session
 * callback.
 *
 * Task children report HITL and authorization transitions to the parent's
 * task run before local emission, so the run can block/unblock the task
 * under one durable decision. A session without a callback capability
 * (non-delegated runs) is a no-op, as is any event outside the three
 * blocking transitions.
 */
export async function forwardTaskEventToSessionCallback(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
): Promise<void> {
  const callback = ctx.get(SessionCallbackKey);
  if (callback === undefined) return;
  if (
    event.type !== "input.requested" &&
    event.type !== "authorization.required" &&
    event.type !== "authorization.completed"
  ) {
    return;
  }
  await fireTaskEventCallbackStep({
    callback,
    childContinuationToken: ctx.require(ContinuationTokenKey),
    childSessionId: ctx.require(SessionIdKey),
    event,
  });
}
