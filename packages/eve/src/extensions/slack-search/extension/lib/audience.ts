import type { SlackSearchAudience } from "../extension.js";
import type { SlackRequest } from "./slack-api.js";

const AUDIENCE_TTL_MS = 5 * 60_000;
const MAX_CACHED = 1000;

interface Cached<T> {
  readonly expiresAt: number;
  readonly value: Promise<T>;
}

const channelSharing = new Map<string, Cached<boolean>>();
const callerStatus = new Map<
  string,
  Cached<{ readonly guest: boolean; readonly external: boolean }>
>();

function remember<T>(
  cache: Map<string, Cached<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (cache.size >= MAX_CACHED) cache.clear();
  const value = load();
  cache.set(key, { expiresAt: Date.now() + AUDIENCE_TTL_MS, value });
  // A failed lookup must be retried, not remembered.
  value.catch(() => cache.delete(key));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function isSharedChannel(request: SlackRequest, channelId: string): Promise<boolean> {
  const response = await request("conversations.info", { channel: channelId });
  if (response.ok !== true || !isRecord(response.channel)) {
    throw new Error(`Slack conversations.info failed: ${response.error ?? "unknown_error"}.`);
  }
  return response.channel.is_ext_shared === true || response.channel.is_pending_ext_shared === true;
}

async function callerOf(request: SlackRequest, userId: string, teamId: string | undefined) {
  const response = await request("users.info", { user: userId });
  if (response.ok !== true || !isRecord(response.user)) {
    throw new Error(`Slack users.info failed: ${response.error ?? "unknown_error"}.`);
  }
  const user = response.user;
  const homeTeam = typeof user.team_id === "string" ? user.team_id : undefined;
  return {
    guest: user.is_restricted === true || user.is_ultra_restricted === true,
    // Anyone whose home workspace isn't the installation's counts as external, including people
    // from another workspace of the same Enterprise Grid org.
    external: user.is_stranger === true || (!!teamId && !!homeTeam && homeTeam !== teamId),
  };
}

/**
 * Where a Slack caller asked and who they are, read with the bot token. When Slack can't say,
 * the caller is treated as an external one in a shared channel, so the default policy only
 * narrows what they see.
 */
export async function slackAudience(
  request: SlackRequest,
  input: { readonly channelId: string; readonly userId: string; readonly teamId?: string },
): Promise<SlackSearchAudience> {
  const team = input.teamId ?? "";
  try {
    const [sharedChannel, caller] = await Promise.all([
      remember(channelSharing, `${team}:${input.channelId}`, () =>
        isSharedChannel(request, input.channelId),
      ),
      remember(callerStatus, `${team}:${input.userId}`, () =>
        callerOf(request, input.userId, input.teamId),
      ),
    ]);
    return { channelId: input.channelId, sharedChannel, ...caller };
  } catch {
    return { channelId: input.channelId, sharedChannel: true, guest: false, external: true };
  }
}
