import { type parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";

import { toSessionSendOptions } from "#channel/session.js";
import { createLogger } from "#internal/logging.js";
import { buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import type {
  SlackChannelConfig,
  SlackReceiveTarget,
  SlackSlashCommand,
  SlackSlashCommandContext,
} from "#public/channels/slack/slackChannel.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";
import type { GenericReceiveInput } from "#shared/channel-definition.js";
import type { Delivery } from "#shared/delivery.js";

const log = createLogger("slack.slash-command");

type SlashCommandPayload = Extract<
  ReturnType<typeof parseSlackWebhookBody>,
  { kind: "slash_command" }
>;

/** The channel's proactive receive, seeded with the Slack trigger that started it. */
export type ReceiveOnSlack = (
  input: GenericReceiveInput<SlackReceiveTarget>,
  trigger: {
    readonly installationTeamId?: string;
    readonly teamId?: string;
    readonly triggeringUserId?: string;
  },
) => Promise<Delivery>;

export function dispatchSlashCommand(
  payload: SlashCommandPayload,
  ctx: { readonly waitUntil: (task: Promise<unknown>) => void },
  deps: {
    readonly api: SlackTransportOptions | undefined;
    readonly config: SlackChannelConfig;
    readonly receive: ReceiveOnSlack;
  },
): void {
  const command = parseSlashCommandPayload(payload);
  const onSlashCommand = deps.config.onSlashCommand;
  if (onSlashCommand === undefined) {
    log.warn("Slack slash command ignored because onSlashCommand is not configured", {
      command: command.command,
    });
    return;
  }

  const commandCtx: SlackSlashCommandContext = {
    defaultAuth: buildSlackAuthContext({
      channelId: command.channelId,
      installationTeamId: command.teamId,
      teamId: command.teamId,
      userId: command.user.id,
      userName: command.user.username,
    }),
    send: (message, options) =>
      deps.receive(
        { ...toSessionSendOptions(options), target: options.target, message },
        {
          installationTeamId: command.teamId,
          teamId: command.teamId,
          triggeringUserId: command.user.id,
        },
      ),
    slack: buildSlackWorkspaceHandle({
      api: deps.api,
      botToken: deps.config.credentials?.botToken,
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
