import type { ContextContainer } from "#context/container.js";
import {
  CallerRemoteAgentProtocolKey,
  ContinuationTokenKey,
  SessionCallbackKey,
  SessionIdKey,
  SessionInboxKey,
} from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { LEGACY_REMOTE_AGENT_PROTOCOL_VERSION } from "#protocol/remote-agent-protocol.js";

/** A remote session sends input to its caller instead of presenting it on its own channel. */
export async function forwardSessionInput(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
  inputSource?: string,
): Promise<boolean> {
  const callback = ctx.get(SessionCallbackKey);
  if (callback === undefined) return false;
  // Protocol-1 callers reject these callback kinds; their children keep input on their own channel.
  if (ctx.get(CallerRemoteAgentProtocolKey) === LEGACY_REMOTE_AGENT_PROTOCOL_VERSION) return false;
  if (
    event.type !== "input.requested" &&
    event.type !== "authorization.required" &&
    event.type !== "authorization.completed" &&
    event.type !== "approval.candidate" &&
    event.type !== "approval.settled"
  )
    return false;

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
