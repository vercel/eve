import type { SessionEvent } from "#protocol/session-event.js";
import type { ContextContainer } from "#context/container.js";
import {
  ContinuationTokenKey,
  SessionCallbackKey,
  SessionIdKey,
  SessionInboxKey,
} from "#context/keys.js";
import { openedBatch, relayedInteractionEvent } from "#harness/interaction-relay.js";
import { currentView } from "#harness/session-machine/current.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

/** A remote session sends input to its caller instead of presenting it on its own channel. */
export async function forwardSessionInput(
  ctx: ContextContainer,
  event: SessionEvent,
  inputSource?: string,
): Promise<boolean> {
  const callback = ctx.get(SessionCallbackKey);
  if (callback === undefined) return false;
  const view = currentView(ctx);
  const batch =
    event.type === "interaction.opened" && event.data.request.kind !== "sign-in"
      ? openedBatch(view, event.data.interactionId)
      : undefined;
  const relayed = batch === undefined ? relayedInteractionEvent(view, event) : undefined;
  if (batch === undefined && relayed === undefined) {
    // Every other request of a batch rides with its first; the session keeps it off its channel.
    return event.type === "interaction.opened";
  }

  const body =
    batch !== undefined
      ? {
          callId: callback.callId,
          childContinuationToken:
            ctx.get(ContinuationTokenKey) ?? sessionCommandHookToken(ctx.require(SessionIdKey)),
          childSessionId: ctx.require(SessionIdKey),
          childSessionInbox: ctx.get(SessionInboxKey),
          event: batch,
          inputSource: inputSource ?? "session",
          kind: "subagent-input-request",
          subagentName: callback.subagentName,
        }
      : {
          callId: callback.callId,
          childSessionId: ctx.require(SessionIdKey),
          event: relayed,
          kind: "subagent-authorization-event",
          subagentName: callback.subagentName,
        };
  const response = await postSessionCallbackRequest({ body, url: callback.url });
  if (!response.ok) throw new Error(`Remote input callback failed with HTTP ${response.status}.`);
  return true;
}
