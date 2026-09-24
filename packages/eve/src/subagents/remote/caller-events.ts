import type { ContextContainer } from "#context/container.js";
import {
  SessionCallbackKey,
  UnsentCallerEventsKey,
  type UnsentCallerEvent,
} from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { createLogger } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  isForwardedAuthorizationEvent,
  type RemoteAuthorizationCallback,
  type RemoteInputRequestedCallback,
} from "#subagents/remote/callback-hitl.js";
import { isTaskProtocolRefusal } from "#subagents/remote/protocol.js";
import { TASK_PROTOCOL_VERSION } from "#tasks/protocol.js";

const log = createLogger("subagents.remote-caller-events");

/**
 * Forwards a remotely called session's input requests and authorization
 * events to its caller's callback, the way the subagent adapter forwards a
 * local child's to its owner's inbox, so the caller's client can answer
 * them. A forward that fails, or that would overtake an earlier failed one,
 * is kept in context and sent again before the session waits for input
 * (`flushUnsentCallerEvents`); retrying it here would re-run the step that
 * emitted it.
 */
export async function forwardEventToRemoteCaller(input: {
  readonly ctx: Pick<ContextContainer, "get" | "set">;
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
    taskProtocol: TASK_PROTOCOL_VERSION,
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
  const entry: UnsentCallerEvent = { body, url: callback.url };
  const unsent = input.ctx.get(UnsentCallerEventsKey) ?? [];
  if (unsent.length === 0 && (await sendCallerEvent(entry, { logFailures: false })) !== "retry") {
    return;
  }
  log.warn("keeping an input request for the remote caller to send again", {
    callId: callback.callId,
    eventType: event.type,
  });
  input.ctx.set(UnsentCallerEventsKey, [...unsent, entry]);
}

/**
 * Posts one caller event. `retry` for a transport failure or a status that
 * may clear; a caller that can never take the event (it rejects the body,
 * knows no such callback, or speaks another task protocol version) drops it.
 */
export async function sendCallerEvent(
  entry: UnsentCallerEvent,
  options: { readonly logFailures: boolean },
): Promise<"sent" | "dropped" | "retry"> {
  let response: Response;
  try {
    response = await postSessionCallbackRequest({
      body: entry.body,
      logFailures: options.logFailures,
      url: entry.url,
    });
  } catch {
    return "retry";
  }
  if (response.ok) return "sent";
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 410 ||
    (await isTaskProtocolRefusal(response))
  ) {
    log.warn("the remote caller refused an input request; it is dropped", {
      callId: entry.body.callId,
      kind: entry.body.kind,
      status: response.status,
    });
    return "dropped";
  }
  return "retry";
}
