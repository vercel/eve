import type { SessionEvent } from "#protocol/session-event.js";
import type { ContextContainer } from "#context/container.js";
import {
  ContinuationTokenKey,
  EarlierRemoteCallerKey,
  SessionCallbackKey,
  SessionIdKey,
  SessionInboxKey,
} from "#context/keys.js";
import { relayedInteractionEvents } from "#harness/interaction-relay.js";
import type { SubagentInteractionHookPayload } from "#channel/types.js";
import { currentView } from "#harness/session-machine/current.js";
import { requireApp } from "#context/app.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

export async function forwardSessionInput(
  ctx: ContextContainer,
  event: SessionEvent,
  inputSource?: string,
): Promise<boolean> {
  const callback = ctx.get(SessionCallbackKey);
  if (callback === undefined || ctx.get(EarlierRemoteCallerKey) !== undefined) return false;
  const childSessionId = ctx.require(SessionIdKey);
  const relayed = relayedInteractionEvents(currentView(ctx), event, childSessionId);
  if (relayed.length === 0) return event.type === "interaction.opened";
  const inbox = ctx.get(SessionInboxKey);
  const body: SubagentInteractionHookPayload = {
    callId: callback.callId,
    childSessionId,
    events: relayed,
    kind: "subagent-interaction",
    subagentName: callback.subagentName,
    ...(relayed.some(
      (fact) => fact.type === "interaction.opened" && fact.data.request.kind !== "sign-in",
    ) && {
      route: {
        childContinuationToken:
          ctx.get(ContinuationTokenKey) ?? sessionCommandHookToken(childSessionId),
        inputSource: inputSource ?? "session",
        ...(inbox !== undefined && { childSessionInbox: inbox }),
      },
    }),
  };
  const response = await postSessionCallbackRequest({
    body,
    platform: requireApp(ctx).platform,
    url: callback.url,
  });
  if (!response.ok) throw new Error(`Remote input callback failed with HTTP ${response.status}.`);
  return true;
}
