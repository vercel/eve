import type {
  ConversationSpace,
  ConversationSpaceType,
  ConversationSpaceVisibility,
} from "#shared/conversation-context.js";

/** The space type a Slack event's `channel_type` names, when it names one. */
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

/**
 * The Slack conversation a session is in. The installation team names the
 * workspace, so a Slack Connect channel reads the same for every member. A
 * session with no known team, such as a proactive send without
 * `installationTeamId`, reports no space rather than one that differs from
 * its channel's.
 */
export function slackConversationSpace(state: {
  readonly channelId: string | null;
  readonly teamId: string | null;
  readonly installationTeamId?: string | null;
  readonly spaceType?: ConversationSpaceType;
  readonly spaceVisibility?: ConversationSpaceVisibility;
}): ConversationSpace | undefined {
  if (!state.channelId) return undefined;
  const team = state.installationTeamId || state.teamId;
  // Slack DM conversation IDs start with `D`; proactive sends carry no event to read.
  const type = state.spaceType ?? (state.channelId.startsWith("D") ? "direct" : "shared");
  if (!team) return undefined;
  // A DM is private whatever Slack reported; otherwise only what Slack said.
  const visibility = type === "direct" ? "private" : state.spaceVisibility;
  return {
    id: `slack:${team}:${state.channelId}`,
    type,
    ...(visibility !== undefined && { visibility }),
    workspaceId: `slack:${team}`,
  };
}
