import type { MemoryScopeContext } from "eve/memory";

import { isString } from "../values";

const SLACK_WORKSPACE_ISSUER = /^slack:[TE][A-Z0-9]+$/u;
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]+$/u;

/**
 * Scopes memory to the Slack channel the current caller is speaking from.
 *
 * @param ctx - Trusted session authentication supplied by eve.
 * @returns `["slack-channel", issuer, channelId]`, `local-dev` during local development, or null.
 * @remarks Only Slack webhook principals with a workspace issuer qualify, so other channels can't claim a channel through attributes. One-to-one DMs are disabled because user memory already covers them; group DMs with a legacy `G` ID are treated as channels shared by their members.
 */
export const bySlackChannel = (
  ctx: MemoryScopeContext
): readonly string[] | string | null => {
  const caller = ctx.session.auth.current;
  if (caller?.principalType === "local-dev") {
    return "local-dev";
  }
  if (
    caller?.authenticator !== "slack-webhook" ||
    caller.principalType !== "user" ||
    !caller.issuer ||
    !SLACK_WORKSPACE_ISSUER.test(caller.issuer)
  ) {
    return null;
  }
  const channelId = caller.attributes.channel_id;
  if (!isString(channelId) || !SLACK_CHANNEL_ID.test(channelId)) {
    return null;
  }
  return ["slack-channel", caller.issuer, channelId];
};
