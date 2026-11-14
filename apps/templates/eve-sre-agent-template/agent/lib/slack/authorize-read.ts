import { callSlackApi } from "eve/channels/slack";
import { resolveSlackUser, type SlackUserAuthLike } from "#lib/auth.ts";

type BotToken = Parameters<typeof callSlackApi>[0]["botToken"];
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;

export async function authorizeSlackRead(
  auth: SlackUserAuthLike | null | undefined,
  channel: string,
  botToken: BotToken
): Promise<void> {
  const denied = () =>
    new Error(
      "Slack conversation access denied. Request access from a Slack account that belongs to this conversation."
    );
  const user = resolveSlackUser(auth);
  const userId = auth?.attributes?.user_id;
  if (
    !user ||
    typeof userId !== "string" ||
    !SLACK_USER_ID.test(userId) ||
    user.principalId !== `slack:${user.teamId}:${userId}`
  ) {
    // Service investigations use supplied evidence, not the bot's ambient read access.
    throw denied();
  }

  const seen = new Set<string>();
  const includesCaller = async (
    remaining: number,
    cursor?: string
  ): Promise<boolean> => {
    const response = await callSlackApi({
      body: { channel, cursor, limit: 200 },
      botToken,
      operation: "conversations.members",
    });
    if (!(response.ok && Array.isArray(response.members))) {
      return false;
    }
    if (response.members.includes(userId)) {
      return true;
    }
    const next = response.response_metadata?.next_cursor;
    if (
      remaining <= 1 ||
      typeof next !== "string" ||
      !next.trim() ||
      seen.has(next)
    ) {
      return false;
    }
    seen.add(next);
    return includesCaller(remaining - 1, next);
  };

  let allowed = false;
  try {
    const installation = await callSlackApi({
      body: {},
      botToken,
      operation: "auth.test",
    });
    if (installation.ok && installation.team_id === user.teamId) {
      allowed = await includesCaller(20);
    }
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw denied();
  }
}
