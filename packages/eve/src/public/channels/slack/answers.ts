import { createLogger } from "#internal/logging.js";
import { buildSlackBinding } from "#public/channels/slack/api.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import type {
  SlackChannelConfig,
  SlackAnswerContext,
  SlackAnswerResult,
  SlackAnswerSubmission,
} from "#public/channels/slack/slackChannel.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";

const log = createLogger("slack.interactions");

export async function authorizeAnswer(input: {
  readonly channelId: string;
  readonly deps: {
    readonly api: SlackTransportOptions | undefined;
    readonly config: SlackChannelConfig;
    readonly onAnswers: NonNullable<SlackChannelConfig["onAnswers"]>;
  };
  readonly installationTeamId: string | null | undefined;
  readonly submission: SlackAnswerSubmission;
  readonly teamId: string | null | undefined;
  readonly threadTs: string;
}): Promise<SlackAnswerResult> {
  const defaultAuth = buildSlackAuthContext({
    channelId: input.channelId,
    installationTeamId: input.installationTeamId,
    teamId: input.teamId,
    threadTs: input.threadTs,
    userId: input.submission.user.id,
    userName: input.submission.user.username ?? input.submission.user.name,
  });
  const { thread, slack } = buildSlackBinding({
    api: input.deps.api,
    botToken: input.deps.config.credentials?.botToken,
    channelId: input.channelId,
    threadTs: input.threadTs,
    installationTeamId: input.installationTeamId ?? undefined,
    teamId: input.teamId ?? undefined,
  });
  const ctx: SlackAnswerContext = { defaultAuth, slack, thread };

  try {
    return await input.deps.onAnswers(ctx, input.submission);
  } catch (error) {
    log.error("HITL input response authorization failed", { error });
    return null;
  }
}
