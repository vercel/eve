import { callSlackApi } from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import type { ToolContext } from "eve/tools";

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
  /** Calls Slack with the bot token. */
  readonly request: SlackRequest;
  /**
   * Calls Slack with the caller's own user token, signing them in first when they have none.
   * Resolves to undefined when the mount sets no `userAuth` or the caller isn't a person.
   */
  readonly userRequest: () => Promise<SlackRequest | undefined>;
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

/** The parts of the tool context a Slack tool call reads. */
export type SlackTurnContext = Pick<ToolContext, "getToken" | "requireAuth"> & {
  readonly session: { readonly auth: { readonly current: SessionAuthContext | null } };
};

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

/** Slack errors that mean the user token itself is no good, so the caller must sign in again. */
const REJECTED_USER_TOKEN = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

const userTokenTeams = new Map<string, string>();

async function userTokenTeam(token: string, request: SlackRequest): Promise<string | undefined> {
  const cached = userTokenTeams.get(token);
  if (cached) return cached;
  const response = await request("auth.test", {});
  if (response.ok !== true || typeof response.team_id !== "string") return undefined;
  if (userTokenTeams.size >= 512) userTokenTeams.clear();
  userTokenTeams.set(token, response.team_id);
  return response.team_id;
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
export function slackTurn(ctx: SlackTurnContext, config: SlackSearchExtensionConfig): SlackTurn {
  const auth = ctx.session.auth.current;
  const teamId = slackTeamId(auth);
  const slackCaller = auth?.authenticator === "slack-webhook" ? auth : undefined;
  const actionToken = slackCaller && attribute(slackCaller, "action_token");
  const { userAuth } = config;
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
    async userRequest() {
      // Only a person can sign in; schedules and service callers keep the bot-token results.
      if (!userAuth || auth?.principalType !== "user") return undefined;
      const { token } = await ctx.getToken(userAuth);
      const withUserToken: SlackRequest = async (operation, body) => {
        const response = await callSlackApi({ api: config.api, botToken: token, operation, body });
        if (response.ok === true) return response;
        if (REJECTED_USER_TOKEN.has(response.error ?? "")) ctx.requireAuth(userAuth);
        if (response.error === "missing_scope") {
          throw new Error(
            `Slack ${operation} needs a user token scope the Slack sign-in doesn't grant (needed: ${response.needed ?? "unknown"}). Add the scope to the sign-in's user scopes; the person must then sign in again.`,
          );
        }
        return response;
      };
      // The person may have signed in from another workspace. Their token must not search or read
      // that workspace from this one, so it is used only for the workspace the turn came from.
      if (teamId && (await userTokenTeam(token, withUserToken)) !== teamId) return undefined;
      return withUserToken;
    },
    authorize: async (access) => {
      const slack = await audienceOnce();
      return (await policy({ ...access, auth, slack })) === true;
    },
  };
}
