import type { TeamsChannelState } from "#public/channels/teams/teamsChannel.js";
import type {
  ConversationSpace,
  ConversationSpaceType,
  ConversationSpaceVisibility,
} from "#shared/conversation-context.js";

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
    return state.channelId ? scoped(state.channelId, "shared") : undefined;
  }
  if (!state.conversationId) return undefined;
  if (state.conversationType === "personal") {
    return scoped(state.conversationId, "direct", "private");
  }
  if (state.conversationType === "groupChat") {
    return scoped(state.conversationId, "shared", "private");
  }
  return undefined;
}
