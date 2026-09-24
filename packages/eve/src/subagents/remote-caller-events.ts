import type { ContextContainer } from "#context/container.js";
import { SessionCallbackKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { createLogger } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  isForwardedAuthorizationEvent,
  type RemoteAuthorizationCallback,
  type RemoteInputRequestedCallback,
} from "#subagents/callback-hitl.js";

const log = createLogger("subagents.remote-caller-events");

/**
 * Forwards a remotely called session's input requests and authorization
 * events to its caller's callback, the way the subagent adapter forwards a
 * local child's to its owner's inbox, so the caller's client can answer
 * them. A request that does not arrive is bounded by the caller's deadline;
 * like the local path, a failed forward is logged, not retried.
 */
export async function forwardEventToRemoteCaller(input: {
  readonly ctx: Pick<ContextContainer, "get">;
  readonly event: UnstampedMessageStreamEvent;
  readonly sessionId: string;
}): Promise<void> {
  const callback = input.ctx.get(SessionCallbackKey);
  if (callback === undefined) return;
  const { event } = input;
  const coordinates = {
    callId: callback.callId,
    sessionId: input.sessionId,
    subagentName: callback.subagentName,
  };
  let body: RemoteInputRequestedCallback | RemoteAuthorizationCallback;
  if (event.type === "input.requested") {
    const { requests, sequence, stepIndex, turnId } = event.data;
    body = {
      ...coordinates,
      event: { requests: [...requests], sequence, stepIndex, turnId },
      kind: "input.requested",
    };
  } else if (isForwardedAuthorizationEvent(event)) {
    body = { ...coordinates, event, kind: "authorization.event" };
  } else {
    return;
  }
  try {
    await postSessionCallbackRequest({ body, url: callback.url });
  } catch {
    log.warn("failed to forward an input request to the remote caller", {
      callId: callback.callId,
      eventType: event.type,
    });
  }
}
