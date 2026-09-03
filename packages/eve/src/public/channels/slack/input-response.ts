import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import { buildSlackBinding } from "#public/channels/slack/api.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import { deriveHitlResponse } from "#public/channels/slack/hitl.js";
import { deriveChildSessionLimitGroupResponse } from "#public/channels/slack/child-session-limits.js";
import type {
  SlackChannelConfig,
  SlackInputResponseContext,
  SlackInputResponseResult,
  SlackInputResponseSubmission,
  SlackChannelState,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.interactions");

export function approvalResponderStatePatch(
  submission: Extract<SlackInputResponseSubmission, { type: "block_actions" }>,
  auth: SessionAuthContext | null,
): Partial<SlackChannelState> | undefined {
  const toolApproval = submission.actions.some(
    (action) => deriveHitlResponse(action)?.kind === "tool-approval",
  );
  const submittedChildGroups: Record<string, number> = {};
  const childGroupSubmissions: NonNullable<SlackChannelState["childSessionLimitGroupSubmissions"]> =
    {};
  for (const action of submission.actions) {
    const childGroup = deriveChildSessionLimitGroupResponse(action);
    if (childGroup !== null) {
      submittedChildGroups[childGroup.groupId] = childGroup.revision;
      childGroupSubmissions[childGroup.groupId] = {
        ...(action.messageTs === undefined ? {} : { messageTs: action.messageTs }),
        optionId: childGroup.optionId,
        revision: childGroup.revision,
      };
    }
  }
  const recordsApprovalResponder = auth?.principalId !== undefined && toolApproval;
  if (!recordsApprovalResponder && Object.keys(submittedChildGroups).length === 0) {
    return undefined;
  }

  return {
    ...(recordsApprovalResponder
      ? { approvalResponderUsers: { [auth.principalId]: submission.user.id } }
      : {}),
    ...(Object.keys(submittedChildGroups).length > 0
      ? {
          childSessionLimitGroupSubmissions: childGroupSubmissions,
          submittedChildSessionLimitGroupRevisions: submittedChildGroups,
        }
      : {}),
  };
}

export async function authorizeInputResponse(input: {
  readonly channelId: string;
  readonly deps: {
    readonly config: SlackChannelConfig;
    readonly onInputResponse: NonNullable<SlackChannelConfig["onInputResponse"]>;
  };
  readonly installationTeamId: string | null | undefined;
  readonly submission: SlackInputResponseSubmission;
  readonly teamId: string | null | undefined;
  readonly threadTs: string;
}): Promise<SlackInputResponseResult> {
  const defaultAuth = buildSlackAuthContext({
    channelId: input.channelId,
    teamId: input.teamId,
    threadTs: input.threadTs,
    userId: input.submission.user.id,
    userName: input.submission.user.username ?? input.submission.user.name,
  });
  const { thread, slack } = buildSlackBinding({
    botToken: input.deps.config.credentials?.botToken,
    channelId: input.channelId,
    threadTs: input.threadTs,
    installationTeamId: input.installationTeamId ?? undefined,
    teamId: input.teamId ?? undefined,
  });
  const ctx: SlackInputResponseContext = { defaultAuth, slack, thread };

  try {
    return await input.deps.onInputResponse(ctx, input.submission);
  } catch (error) {
    log.error("HITL input response authorization failed", { error });
    return null;
  }
}
