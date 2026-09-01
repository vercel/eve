import { type parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";

import { createLogger } from "#internal/logging.js";
import { buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import type {
  SlackChannelConfig,
  SlackSlashCommand,
  SlackSlashCommandContext,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.slash-command");

type SlashCommandPayload = Extract<
  ReturnType<typeof parseSlackWebhookBody>,
  { kind: "slash_command" }
>;

export function dispatchSlashCommand(
  payload: SlashCommandPayload,
  ctx: { readonly waitUntil: (task: Promise<unknown>) => void },
  config: SlackChannelConfig,
): void {
  const command = parseSlashCommandPayload(payload);
  const onSlashCommand = config.onSlashCommand;
  if (onSlashCommand === undefined) {
    log.warn("Slack slash command ignored because onSlashCommand is not configured", {
      command: command.command,
    });
    return;
  }

  const commandCtx: SlackSlashCommandContext = {
    slack: buildSlackWorkspaceHandle({
      botToken: config.credentials?.botToken,
      installationTeamId: command.teamId,
      teamId: command.teamId,
    }),
  };
  ctx.waitUntil(
    Promise.resolve()
      .then(() => onSlashCommand(command, commandCtx))
      .catch((error: unknown) => {
        log.error("slash command handler failed", { error });
      }),
  );
}

function parseSlashCommandPayload(payload: SlashCommandPayload): SlackSlashCommand {
  return {
    command: payload.command,
    text: payload.text,
    user: { id: payload.userId, username: payload.userName },
    teamId: payload.teamId,
    channelId: payload.channelId,
    channelName: payload.channelName,
    enterpriseId: payload.enterpriseId,
    isEnterpriseInstall: payload.isEnterpriseInstall,
    triggerId: payload.triggerId,
    responseUrl: payload.responseUrl,
  };
}
