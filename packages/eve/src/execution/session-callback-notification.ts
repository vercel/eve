import { parseCallbackMetadata } from "#channel/session-callback.js";
import type { ContextReader } from "#context/key.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { postSessionCallback } from "#execution/session-callback-post.js";
import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const log = createLogger("execution.session-callback-notification");

/**
 * Forwards one notification-worthy stream event to the session's
 * registered callback URL as a `status: "notification"` callback event.
 *
 * The callback-URL analog of the local subagent adapter's
 * `subagent-authorization-event` forwarding: a callee dispatched with a
 * {@link SessionCallback} has no hook into its caller, so authorization
 * lifecycle events are POSTed to the callback URL, where the caller
 * re-emits them on its own stream without resolving the pending call.
 *
 * No-op for sessions without callback metadata and for every other event
 * type. Delivery is best-effort: unlike the terminal callback, a failed
 * POST is logged and swallowed so an unreachable caller never fails the
 * callee's turn.
 */
export async function forwardSessionCallbackNotification(input: {
  readonly ctx: ContextReader;
  readonly event: HandleMessageStreamEvent;
}): Promise<void> {
  const { event } = input;
  if (event.type !== "authorization.required" && event.type !== "authorization.completed") {
    return;
  }

  const value = input.ctx.get(SessionCallbackKey);
  if (value === undefined) {
    return;
  }

  const sessionId = input.ctx.get(SessionIdKey) ?? "";
  const parsed = parseCallbackMetadata(value);
  if (!parsed.ok) {
    log.warn("skipping session callback notification: invalid callback metadata", {
      eventType: event.type,
      message: parsed.message,
      sessionId,
    });
    return;
  }

  try {
    await postSessionCallback({
      payload: {
        callId: parsed.callback.callId,
        event: { ...event, status: "notification" },
        sessionId,
        subagentName: parsed.callback.subagentName,
      },
      url: parsed.callback.url,
    });
  } catch (error) {
    log.warn("failed to post session callback notification", {
      error,
      eventType: event.type,
      sessionId,
    });
  }
}
