import type { ContextContainer } from "#context/container.js";
import {
  ContinuationTokenKey,
  SessionCallbackKey,
  SessionIdKey,
  SessionInboxKey,
} from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/** The input events a remote session sends its caller instead of presenting them on its own channel. */
export type ForwardedSessionInputEvent = Extract<
  UnstampedMessageStreamEvent,
  {
    readonly type:
      | "input.requested"
      | "authorization.required"
      | "authorization.completed"
      | "approval.candidate"
      | "approval.settled";
  }
>;

function isForwardedSessionInput(
  event: UnstampedMessageStreamEvent,
): event is ForwardedSessionInputEvent {
  return (
    event.type === "input.requested" ||
    event.type === "authorization.required" ||
    event.type === "authorization.completed" ||
    event.type === "approval.candidate" ||
    event.type === "approval.settled"
  );
}

/** A remote session sends input to its caller instead of presenting it on its own channel. */
export async function forwardSessionInput(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
  inputSource?: string,
): Promise<boolean> {
  const callback = ctx.get(SessionCallbackKey);
  if (callback === undefined) return false;
  if (!isForwardedSessionInput(event)) return false;

  const body =
    event.type === "input.requested"
      ? {
          callId: callback.callId,
          childContinuationToken:
            ctx.get(ContinuationTokenKey) ?? sessionCommandHookToken(ctx.require(SessionIdKey)),
          childSessionId: ctx.require(SessionIdKey),
          childSessionInbox: ctx.get(SessionInboxKey),
          event: event.data,
          inputSource: inputSource ?? "session",
          kind: "subagent-input-request",
          subagentName: callback.subagentName,
        }
      : {
          callId: callback.callId,
          childSessionId: ctx.require(SessionIdKey),
          event,
          kind: "subagent-authorization-event",
          subagentName: callback.subagentName,
        };
  const response = await postSessionCallbackRequest({ body, url: callback.url });
  if (!response.ok) throw new Error(`Remote input callback failed with HTTP ${response.status}.`);
  return true;
}
