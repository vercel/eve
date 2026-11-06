import { callSlackApi } from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";

import type { SlackSearchAccessRequest, SlackSearchExtensionConfig } from "../extension.js";
import type { SlackRequest } from "./slack-api.js";

/** The Slack details of one tool call: who is asking, in which workspace, with what credentials. */
export interface SlackTurn {
  readonly auth: SessionAuthContext | null;
  /** The workspace whose app installation received the turn's message. */
  readonly teamId?: string;
  /** The `action_token` of the Slack message that started the turn. */
  readonly actionToken?: string;
  readonly request: SlackRequest;
  readonly authorize: (request: Omit<SlackSearchAccessRequest, "auth">) => Promise<boolean>;
}

function attribute(auth: SessionAuthContext, name: string): string | undefined {
  const value = auth.attributes[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const TEAM_ID = /^T[A-Z0-9]+$/;

function slackTeamId(auth: SessionAuthContext | null): string | undefined {
  if (auth?.authenticator !== "slack-webhook") return undefined;
  // eve's Slack auth names the installation workspace in the issuer (`slack:T…`), which is
  // the workspace whose bot token can read; `team_id` is the sender's and differs for Slack Connect.
  const issuerTeam = auth.issuer?.startsWith("slack:") ? auth.issuer.slice(6) : undefined;
  if (issuerTeam && TEAM_ID.test(issuerTeam)) return issuerTeam;
  const team = attribute(auth, "team_id");
  return team && TEAM_ID.test(team) ? team : undefined;
}

/** Reads the turn's Slack identity and binds the mount's credentials and access policy. */
export function slackTurn(
  auth: SessionAuthContext | null,
  config: SlackSearchExtensionConfig,
): SlackTurn {
  const teamId = slackTeamId(auth);
  const actionToken =
    auth?.authenticator === "slack-webhook" ? attribute(auth, "action_token") : undefined;
  return {
    auth,
    teamId,
    actionToken,
    request: (operation, body) =>
      callSlackApi({
        api: config.api,
        botToken: config.credentials?.botToken,
        context: teamId ? { teamId } : {},
        operation,
        body,
      }),
    authorize: async (request) =>
      config.authorize ? (await config.authorize({ ...request, auth })) === true : true,
  };
}
