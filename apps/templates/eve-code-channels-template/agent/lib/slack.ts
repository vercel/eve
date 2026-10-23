import { callSlackApi } from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";

import { slackCredentials } from "../channels/slack";
import { currentCodeChannel, type SlackCall } from "./code-channels";

/**
 * The current turn's code channel with Slack Web API access, for tools, which
 * run outside an inbound Slack handler. `undefined` outside a code channel.
 */
export function codeChannelTarget(auth: SessionAuthContext | null | undefined) {
  const code = currentCodeChannel(auth);
  if (!code) return undefined;
  const call: SlackCall = async (operation, body) =>
    (await callSlackApi({
      botToken: slackCredentials.botToken,
      context: { teamId: code.teamId },
      operation,
      body,
    })) as Record<string, unknown>;
  return { channelId: code.channelId, call };
}

export const NOT_IN_CODE_CHANNEL = {
  ok: false as const,
  error: "This tool only works inside a Slack code channel.",
};
