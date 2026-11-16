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

// The label excludes `<` so a failed match can't rescan later mentions;
// otherwise unterminated `<@U1|` runs make matching quadratic.
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/gu;
// Bounds the users.info calls one tool result makes.
const MAX_NAME_LOOKUPS = 30;

/** User IDs mentioned as `<@U…>` in Slack message text. */
export function mentionedUserIds(text: string): string[] {
  return [...text.matchAll(MENTION)].map((match) => match[1]!);
}

/**
 * Looks up display names for Slack users and bots, so the agent can refer to
 * them by name instead of an ID or a mention that would notify them. IDs Slack
 * can't resolve, including failed or rate-limited lookups, are left out so a
 * missing name never fails the read that asked for it.
 */
export async function slackUserNames(
  teamId: string,
  ids: Iterable<string | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => !!id))].slice(
    0,
    MAX_NAME_LOOKUPS,
  );
  const entries = await Promise.all(
    unique.map(async (id) => {
      const response = await callSlack<{
        user: { name?: string; real_name?: string; profile?: { display_name?: string } };
      }>(teamId, "users.info", { user: id }).catch(() => undefined);
      const user = response?.ok ? response.user : undefined;
      return [id, user?.profile?.display_name || user?.real_name || user?.name] as const;
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, string] => !!entry[1]));
}

/** Replaces `<@U…>` mentions with `@Name`, keeping mentions it has no name for. */
export function nameMentions(text: string, names: ReadonlyMap<string, string>): string {
  return text.replace(MENTION, (mention, id: string) => {
    const name = names.get(id);
    return name ? `@${name}` : mention;
  });
}
