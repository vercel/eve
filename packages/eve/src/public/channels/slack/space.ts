import type {
  ConversationSpace,
  ConversationSpaceType,
  ConversationSpaceVisibility,
} from "#shared/conversation-context.js";

export function readSlackSpaceType(
  raw: Readonly<Record<string, unknown>> | undefined,
): ConversationSpaceType | undefined {
  switch (raw?.channel_type) {
    case "im":
      return "direct";
    case "mpim":
    case "channel":
    case "group":
      return "shared";
    default:
      return undefined;
  }
}

export function slackConversationSpace(state: {
  readonly channelId: string | null;
  readonly teamId: string | null;
  readonly installationTeamId?: string | null;
  readonly spaceType?: ConversationSpaceType;
  readonly spaceVisibility?: ConversationSpaceVisibility;
}): ConversationSpace | undefined {
  if (!state.channelId) return undefined;
  const team = state.installationTeamId || state.teamId;
  const type = state.spaceType ?? (state.channelId.startsWith("D") ? "direct" : "shared");
  if (!team) return undefined;
  const visibility = type === "direct" ? "private" : state.spaceVisibility;
  return {
    id: `slack:${team}:${state.channelId}`,
    type,
    ...(visibility !== undefined && { visibility }),
    workspaceId: `slack:${team}`,
  };
}
