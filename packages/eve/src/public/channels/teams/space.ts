import type { TeamsChannelState } from "#public/channels/teams/teamsChannel.js";
import type { ConversationSpace, ConversationSpaceType } from "#shared/conversation-context.js";

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
  const scoped = (id: string, type: ConversationSpaceType): ConversationSpace => ({
    id: `${workspaceId}:${id}`,
    type,
    workspaceId,
  });
  if (state.conversationType === "channel") {
    return state.channelId ? scoped(state.channelId, "channel") : undefined;
  }
  if (!state.conversationId) return undefined;
  if (state.conversationType === "personal") return scoped(state.conversationId, "direct");
  if (state.conversationType === "groupChat") return scoped(state.conversationId, "group");
  return undefined;
}
