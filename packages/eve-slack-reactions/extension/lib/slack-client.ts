import type { InstrumentationChannel } from "eve/channels";
import {
  callSlackApi,
  type SlackChannelCredentials,
  type SlackTransportOptions,
} from "eve/channels/slack";

import type { SlackReactionClient } from "./reactions.ts";

/**
 * Slack reaction calls with the mount's credentials and API host. The token
 * resolves for the workspace serving `channel`, as the Slack channel's own
 * calls do.
 */
export function reactionClient(
  channel: InstrumentationChannel,
  options: {
    readonly credentials?: Pick<SlackChannelCredentials, "botToken">;
    readonly api?: SlackTransportOptions;
  },
): SlackReactionClient {
  const { installationTeamId, teamId } = channel.metadata;
  const team =
    typeof installationTeamId === "string"
      ? installationTeamId
      : typeof teamId === "string"
        ? teamId
        : undefined;
  const call = (operation: string) => (body: object) =>
    callSlackApi({
      api: options.api,
      botToken: options.credentials?.botToken,
      context: team === undefined ? undefined : { teamId: team },
      operation,
      body,
    }) as Promise<{ readonly ok?: boolean; readonly error?: string }>;
  return { reactions: { add: call("reactions.add"), remove: call("reactions.remove") } };
}
