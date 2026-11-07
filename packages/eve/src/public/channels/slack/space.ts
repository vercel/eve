import type { ConversationSpace, ConversationSpaceType } from "#shared/conversation-context.js";

/** The space type a Slack event's `channel_type` names, when it names one. */
export function readSlackSpaceType(
  raw: Readonly<Record<string, unknown>> | undefined,
): ConversationSpaceType | undefined {
  switch (raw?.channel_type) {
    case "im":
      return "direct";
    case "mpim":
      return "group";
    case "channel":
    case "group":
      return "channel";
    default:
      return undefined;
  }
}

/**
 * The Slack conversation a session is in. The installation team names the
 * workspace, so a Slack Connect channel reads the same for every member.
 */
export function slackConversationSpace(state: {
  readonly channelId: string | null;
  readonly teamId: string | null;
  readonly installationTeamId?: string | null;
  readonly spaceType?: ConversationSpaceType;
}): ConversationSpace | undefined {
  if (!state.channelId) return undefined;
  const team = state.installationTeamId || state.teamId;
  // Slack DM conversation IDs start with `D`; proactive sends carry no event to read.
  const type = state.spaceType ?? (state.channelId.startsWith("D") ? "direct" : "channel");
  return team
    ? { id: `slack:${team}:${state.channelId}`, type, workspaceId: `slack:${team}` }
    : { id: `slack:${state.channelId}`, type };
}
