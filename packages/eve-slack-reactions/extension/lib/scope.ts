import type { InstrumentationChannel } from "eve/channels";

import type { ReactionScope } from "../extension.ts";

/** The kind eve gives a Slack channel declared at `agent/channels/slack.ts`. */
const DEFAULT_SLACK_CHANNEL_KIND = "channel:slack";

/**
 * Where the reaction tools act when the mount passes no `scope`: sessions on
 * the agent's `channels/slack.ts` channel, targeting the message the turn
 * answers, or the thread root when that is unknown. Null otherwise.
 */
export function defaultReactionScope(channel: InstrumentationChannel): ReactionScope | null {
  if (channel.kind !== DEFAULT_SLACK_CHANNEL_KIND) return null;
  const { channelId, threadTs, triggeringMessageTs } = channel.metadata;
  if (typeof channelId !== "string" || channelId.length === 0) return null;
  const messageTs = nonEmpty(triggeringMessageTs) ?? nonEmpty(threadTs);
  return messageTs === undefined ? { channelId } : { channelId, messageTs };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
