import type { ToolContext } from "#tools/definition.js";
import { callSlackApi, type SlackApiResponse } from "#public/channels/slack/api.js";
import { slackChannelTransport } from "#public/channels/slack/channel-transport.js";
import type { SlackChannel } from "#public/channels/slack/slackChannel.js";

/**
 * The Slack conversation a tool call came from, with a Web API caller signed
 * by the serving channel's own credentials. Returned by {@link slackToolContext}.
 */
export interface SlackToolContext {
  /** Slack channel id. */
  readonly channelId: string;
  /**
   * Slack thread root ts (or the message ts when not in a thread). Empty in a
   * code channel, which is one session across its threads.
   */
  readonly threadTs: string;
  /** Whether the session serves a Slack code channel. */
  readonly codeChannel: boolean;
  /** Slack team id, when the inbound event carried one. */
  readonly teamId: string | undefined;
  /** ts of the message that started the current turn, when there is one. */
  readonly triggeringMessageTs: string | undefined;
  /**
   * POST to a Slack Web API method with the channel's bot token and API host.
   * Returns Slack's raw JSON response; callers check `response.ok` themselves.
   */
  request(operation: string, body: unknown): Promise<SlackApiResponse>;
}

/**
 * Gives a tool the Slack conversation its session runs on, and a
 * `request(op, body)` built from the same credentials and API host the
 * channel uses for its hooks, so the tool needs no token of its own.
 *
 * Pass the agent's Slack channel, as {@link openCodeChannel} does:
 *
 * ```ts
 * async execute({ name }, ctx) {
 *   const conversation = slackToolContext(ctx, slack);
 *   if (conversation?.triggeringMessageTs === undefined) return "Not in Slack.";
 *   await conversation.request("reactions.add", {
 *     channel: conversation.channelId,
 *     name,
 *     timestamp: conversation.triggeringMessageTs,
 *   });
 * }
 * ```
 *
 * Returns `null` when the session isn't on a Slack channel.
 */
export function slackToolContext(
  ctx: Pick<ToolContext, "channel">,
  slack: SlackChannel,
): SlackToolContext | null {
  const { channelId, codeChannel, installationTeamId, teamId, threadTs, triggeringMessageTs } =
    ctx.channel.metadata ?? {};
  if (typeof channelId !== "string") return null;

  const transport = slackChannelTransport(slack);
  if (transport === undefined) {
    throw new Error(
      "slackToolContext() needs the channel slackChannel() returned. Import it from your " +
        'agent\'s channels directory, e.g. `import slack from "../channels/slack"`.',
    );
  }
  const context = typeof installationTeamId === "string" ? { teamId: installationTeamId } : {};
  return {
    channelId,
    threadTs: typeof threadTs === "string" ? threadTs : "",
    codeChannel: codeChannel === true,
    teamId: typeof teamId === "string" ? teamId : undefined,
    triggeringMessageTs: typeof triggeringMessageTs === "string" ? triggeringMessageTs : undefined,
    request: (operation, body) =>
      callSlackApi({ api: transport.api, botToken: transport.botToken, context, operation, body }),
  };
}
