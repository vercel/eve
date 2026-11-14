import type { MemoryScopeContext } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

import { SLACK_CHANNEL_ID } from "../slack-ids";
import { isString } from "../values";

const SLACK_WORKSPACE_ISSUER = /^slack:[TE][A-Z0-9]+$/u;

/**
 * Scopes memory to the current human caller.
 *
 * @param ctx - Trusted session authentication supplied by eve.
 * @returns eve's per-principal scope for a person or local development, otherwise null.
 * @remarks Service principals, such as Slack Workflows and other bots, get no memory, so text a bot posts cannot save preferences that later turns recall. Runtime and anonymous callers also get no memory, because `byPrincipal` returns null for them. Human scopes match `byPrincipal`, so existing preferences keep their storage key.
 */
export const byHumanPrincipal = (ctx: MemoryScopeContext): string | null =>
  ctx.session.auth.current?.principalType === "service"
    ? null
    : byPrincipal(ctx);

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
