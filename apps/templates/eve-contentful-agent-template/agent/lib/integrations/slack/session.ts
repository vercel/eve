import type { SessionAuthContext } from "eve/context";

import { isString } from "../../values";
/**
 * The slice of eve's tool context that carries the Slack origin.
 */
export interface SlackSessionContext {
  session: {
    auth: {
      current: { attributes: SessionAuthContext["attributes"] } | null;
      initiator: { attributes: SessionAuthContext["attributes"] } | null;
    };
  };
}

/**
 * Reads the original Slack thread coordinates from authenticated session attributes.
 *
 * @param ctx - Session exposing its initiating and current principals.
 * @returns The initiating principal's thread, then the current principal's thread, or null.
 * @remarks Preferring the initiator keeps approval and visualization replies in the original thread.
 */
export const slackThreadFromSession = (
  ctx: SlackSessionContext
): { channelId: string; ts: string } | null => {
  for (const principal of [
    ctx.session.auth.initiator,
    ctx.session.auth.current,
  ]) {
    const attrs = principal?.attributes;
    const channelId = attrs?.channel_id;
    const ts = attrs?.thread_ts;
    if (isString(channelId) && channelId && isString(ts) && ts) {
      return { channelId, ts };
    }
  }
  return null;
};

/**
 * Builds a Slack message permalink from its channel and timestamp.
 *
 * @param channelId - Slack channel ID containing the message.
 * @param ts - Slack message timestamp, including its fractional separator.
 * @param host - Workspace hostname; defaults to slack.com.
 * @returns The archive URL with the timestamp formatted for Slack's permalink path.
 */
export const buildPermalink = (
  channelId: string,
  ts: string,
  host = "slack.com"
): string => `https://${host}/archives/${channelId}/p${ts.replace(".", "")}`;
