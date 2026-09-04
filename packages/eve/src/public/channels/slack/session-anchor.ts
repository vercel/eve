import type { ChannelResolveSession } from "#channel/channel-operations.js";
import type { Session } from "#channel/session.js";
import type { SlackHandle } from "#public/channels/slack/api.js";

const ANCHOR_EVENT_TYPE = "eve_session";

export function slackSessionAnchor(channelId: string, continuationToken: string): unknown {
  return {
    event_type: ANCHOR_EVENT_TYPE,
    event_payload: { channel_id: channelId, continuation_token: continuationToken },
  };
}

/** Resolves a proactive root's original alias during the post-to-rekey window. */
export async function resolveSlackSessionAnchor(input: {
  readonly appId: string | undefined;
  readonly channelId: string;
  readonly threadTs: string;
  readonly request: SlackHandle["request"];
  readonly resolveSession: ChannelResolveSession;
}): Promise<{ readonly session: Session; readonly continuationToken: string } | undefined> {
  if (input.appId === undefined || input.threadTs.length === 0) return undefined;
  const response = await input.request("conversations.replies", {
    channel: input.channelId,
    ts: input.threadTs,
    limit: 1,
    include_all_metadata: true,
  });
  if (response.ok !== true) throw new Error("Unable to resolve the Slack session anchor.");
  const root = Array.isArray(response.messages)
    ? (response.messages[0] as Record<string, unknown> | undefined)
    : undefined;
  if (root?.ts !== input.threadTs || root.app_id !== input.appId) return undefined;
  const metadata = root.metadata as
    | { event_type?: unknown; event_payload?: Record<string, unknown> }
    | undefined;
  if (
    metadata?.event_type !== ANCHOR_EVENT_TYPE ||
    metadata.event_payload?.channel_id !== input.channelId
  )
    return undefined;
  const token = metadata.event_payload.continuation_token;
  if (typeof token !== "string" || token.length > 1024 || !token.startsWith(`${input.channelId}:`))
    return undefined;
  const session = await input.resolveSession(token);
  return session === undefined ? undefined : { session, continuationToken: token };
}
