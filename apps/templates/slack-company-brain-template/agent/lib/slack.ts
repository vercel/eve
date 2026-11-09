import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";

// The "Deploy with Vercel" button provisions SLACK_CONNECTOR. To create a
// connector yourself, run `vercel connect create slack --triggers` and put its
// UID in SLACK_CONNECTOR.
export const slackCredentials = connectSlackCredentials(
  process.env.SLACK_CONNECTOR || "slack/company-brain",
);

// When SLACK_TEAM_ID is set, only members of that workspace can reach the agent.
// Slack Connect channels can deliver messages from people in other companies,
// and a company brain usually should not answer them.
export const homeTeamId = process.env.SLACK_TEAM_ID?.trim() || undefined;

export function isHomeTeam(teamId: string | undefined): boolean {
  return homeTeamId === undefined || teamId === homeTeamId;
}

/** The workspace that issued a Slack-derived auth context, from its `slack:<team>` issuer. */
export function slackTeamId(auth: { readonly issuer?: string } | null | undefined) {
  return auth?.issuer?.startsWith("slack:") ? auth.issuer.slice("slack:".length) : undefined;
}

/** Calls the Slack Web API with the app's bot token for one workspace. Resolves to Slack's JSON. */
export async function callSlack<T extends object = Record<string, unknown>>(
  teamId: string,
  operation: string,
  body: Record<string, unknown>,
) {
  const response = await callSlackApi({
    botToken: slackCredentials.botToken,
    context: { teamId },
    operation,
    body,
  });
  return response as { ok: boolean; error?: string } & Partial<T>;
}

/**
 * Whether a Slack user is a full member of the home workspace: not deactivated,
 * not external, and not a guest. Guests can only see the channels they were
 * invited to, but the agent reads with the bot's broader access, so it must not
 * answer them. Throws on errors other than `user_not_found`, which may be transient.
 */
export async function isFullMember(teamId: string, userId: string): Promise<boolean> {
  const response = await callSlack<{
    user: {
      deleted?: boolean;
      is_restricted?: boolean;
      is_ultra_restricted?: boolean;
      team_id?: string;
    };
  }>(teamId, "users.info", { user: userId });
  if (!response.ok) {
    if (response.error === "user_not_found") return false;
    throw new Error(`Slack users.info failed: ${response.error ?? "unknown error"}`);
  }
  const { user } = response;
  return (
    user !== undefined &&
    user.deleted !== true &&
    user.is_restricted !== true &&
    user.is_ultra_restricted !== true &&
    isHomeTeam(user.team_id)
  );
}
