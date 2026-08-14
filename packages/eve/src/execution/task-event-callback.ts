import type { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { fireTaskEventCallbackStep } from "#execution/session-callback-step.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/**
 * Forwards one task child's blocking transition to its parent's session
 * callback.
 *
 * Task children report HITL and authorization transitions exclusively to the
 * parent's task run, so the run can block/unblock the task under one durable
 * decision and only the parent channel owns the interaction. Returns whether
 * the event was forwarded and must therefore be suppressed locally.
 */
export async function forwardTaskEventToSessionCallback(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
): Promise<boolean> {
  const callback = ctx.get(SessionCallbackKey);
  if (callback?.taskId === undefined) return false;
  if (
    event.type !== "input.requested" &&
    event.type !== "authorization.required" &&
    event.type !== "authorization.completed"
  ) {
    return false;
  }
  await fireTaskEventCallbackStep({
    callback,
    childContinuationToken: ctx.require(ContinuationTokenKey),
    childSessionId: ctx.require(SessionIdKey),
    event,
  });
  return true;
}
