import type { TeamsChannelState } from "#public/channels/teams/teamsChannel.js";
import type { ConversationSpace, ConversationSpaceType } from "#shared/conversation-context.js";

/**
 * The Teams chat or channel a session is in. A channel conversation's ID names
 * one thread, so a channel reports the Teams channel instead.
 */
export function teamsConversationSpace(
  state: Pick<TeamsChannelState, "channelId" | "conversationId" | "conversationType" | "tenantId">,
): ConversationSpace | undefined {
  const workspace = state.tenantId ? `teams:${state.tenantId}` : undefined;
  const scoped = (id: string, type: ConversationSpaceType): ConversationSpace =>
    workspace === undefined
      ? { id: `teams:${id}`, type }
      : { id: `${workspace}:${id}`, type, workspaceId: workspace };
  if (state.conversationType === "channel") {
    return state.channelId ? scoped(state.channelId, "channel") : undefined;
  }
  if (!state.conversationId) return undefined;
  if (state.conversationType === "personal") return scoped(state.conversationId, "direct");
  if (state.conversationType === "groupChat") return scoped(state.conversationId, "group");
  return undefined;
}
