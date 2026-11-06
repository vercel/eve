import { callSlackApi } from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";

import type {
  SlackSearchAccessRequest,
  SlackSearchAudience,
  SlackSearchExtensionConfig,
} from "../extension.js";
import { slackAudience } from "./audience.js";
import type { SlackRequest } from "./slack-api.js";

/** The Slack details of one tool call: who is asking, in which workspace, with what credentials. */
export interface SlackTurn {
  readonly auth: SessionAuthContext | null;
  /** The workspace whose app installation received the turn's message. */
  readonly teamId?: string;
  /** The `action_token` of the Slack message that started the turn. */
  readonly actionToken?: string;
  readonly request: SlackRequest;
  readonly authorize: (
    request: Omit<SlackSearchAccessRequest, "auth" | "slack">,
  ) => Promise<boolean>;
}

/** The policy when the mount sets no `authorize`. Slack's own search draws the same lines. */
export function defaultAuthorize({ tool, channelId, slack }: SlackSearchAccessRequest): boolean {
  if (!slack) return true;
  if (slack.guest) return false;
  if (slack.sharedChannel || slack.external) {
    return tool !== "read_user" && channelId === slack.channelId;
  }
  return true;
}

function attribute(auth: SessionAuthContext, name: string): string | undefined {
  const value = auth.attributes[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const TEAM_ID = /^T[A-Z0-9]+$/;

function slackTeamId(auth: SessionAuthContext | null): string | undefined {
  if (auth?.authenticator !== "slack-webhook") return undefined;
  // eve's Slack auth names the installation workspace in the issuer (`slack:T…`), whose bot token
  // can read. `team_id` is the workspace the event arrived for; it says nothing about the sender.
  const issuerTeam = auth.issuer?.startsWith("slack:") ? auth.issuer.slice(6) : undefined;
  if (issuerTeam && TEAM_ID.test(issuerTeam)) return issuerTeam;
  const team = attribute(auth, "team_id");
  return team && TEAM_ID.test(team) ? team : undefined;
}

async function slackAudienceOf(
  caller: SessionAuthContext | undefined,
  request: SlackRequest,
  teamId: string | undefined,
): Promise<SlackSearchAudience | undefined> {
  if (!caller) return undefined;
  const channelId = attribute(caller, "channel_id");
  const userId = attribute(caller, "user_id");
  // A Slack caller without a conversation or user can't be placed, so it sees nothing.
  if (!channelId || !userId) {
    return { channelId: channelId ?? "", sharedChannel: true, external: true, guest: true };
  }
  return slackAudience(request, { channelId, userId, teamId });
}

/** Reads the turn's Slack identity and binds the mount's credentials and access policy. */
export function slackTurn(
  auth: SessionAuthContext | null,
  config: SlackSearchExtensionConfig,
): SlackTurn {
  const teamId = slackTeamId(auth);
  const slackCaller = auth?.authenticator === "slack-webhook" ? auth : undefined;
  const actionToken = slackCaller && attribute(slackCaller, "action_token");
  const request: SlackRequest = (operation, body) =>
    callSlackApi({
      api: config.api,
      botToken: config.credentials?.botToken,
      context: teamId ? { teamId } : {},
      operation,
      body,
    });
  const policy = config.authorize ?? defaultAuthorize;
  let audience: Promise<SlackSearchAudience | undefined> | undefined;
  const audienceOnce = () => {
    audience ??= slackAudienceOf(slackCaller, request, teamId);
    return audience;
  };
  return {
    auth,
    teamId,
    actionToken,
    request,
    authorize: async (access) => {
      const slack = await audienceOnce();
      return (await policy({ ...access, auth, slack })) === true;
    },
  };
}
