import type { TeamsChannelState } from "#public/channels/teams/teamsChannel.js";
import type {
  ConversationSpace,
  ConversationSpaceType,
  ConversationSpaceVisibility,
} from "#shared/conversation-context.js";

/**
 * The Teams chat or channel a session is in. A channel conversation's ID names
 * one thread, so a channel reports the Teams channel instead. A session with
 * no known tenant, such as a proactive send without `tenantId`, reports no
 * space rather than one that differs from its chat's.
 */
export function teamsConversationSpace(
  state: Pick<TeamsChannelState, "channelId" | "conversationId" | "conversationType" | "tenantId">,
): ConversationSpace | undefined {
  if (!state.tenantId) return undefined;
  const workspaceId = `teams:${state.tenantId}`;
  const scoped = (
    id: string,
    type: ConversationSpaceType,
    visibility?: ConversationSpaceVisibility,
  ): ConversationSpace => ({
    id: `${workspaceId}:${id}`,
    type,
    ...(visibility !== undefined && { visibility }),
    workspaceId,
  });
  if (state.conversationType === "channel") {
    // A Teams channel's visibility isn't in the activity.
    return state.channelId ? scoped(state.channelId, "shared") : undefined;
  }
  if (!state.conversationId) return undefined;
  // Chats have fixed members, so they are private.
  if (state.conversationType === "personal") {
    return scoped(state.conversationId, "direct", "private");
  }
  if (state.conversationType === "groupChat") {
    return scoped(state.conversationId, "shared", "private");
  }
  return undefined;
}
