import type { SlackSearchAudience } from "../extension.js";
import type { SlackRequest } from "./slack-api.js";

// Short, so a channel that becomes shared or a member who becomes a guest is noticed quickly.
const AUDIENCE_TTL_MS = 60_000;
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

function lookupFailed(operation: string, error: unknown, scopes: string): Error {
  return new Error(
    `The Slack search tools couldn't check who is asking, because Slack ${operation} failed: ${typeof error === "string" ? error : "unknown_error"}. The Slack app needs ${scopes}. Without that check the tools return nothing to Slack callers.`,
  );
}

async function isSharedChannel(request: SlackRequest, channelId: string): Promise<boolean> {
  const response = await request("conversations.info", { channel: channelId });
  if (response.ok !== true || !isRecord(response.channel)) {
    throw lookupFailed(
      "conversations.info",
      response.error,
      "channels:read, groups:read, im:read, and mpim:read",
    );
  }
  const channel = response.channel;
  // A DM has no sharing flags; whether its other person is external is the caller check's job.
  if (channel.is_im === true) return false;
  // Missing flags mean Slack didn't say, so the conversation is treated as shared.
  return channel.is_ext_shared !== false || channel.is_pending_ext_shared === true;
}

async function callerOf(request: SlackRequest, userId: string, teamId: string | undefined) {
  const response = await request("users.info", { user: userId });
  if (response.ok !== true || !isRecord(response.user)) {
    throw lookupFailed("users.info", response.error, "users:read");
  }
  const user = response.user;
  const homeTeam = typeof user.team_id === "string" ? user.team_id : undefined;
  // Missing fields mean Slack didn't say, so the caller is treated as a guest or as external.
  return {
    guest: user.is_restricted !== false || user.is_ultra_restricted === true,
    // Anyone whose home workspace isn't the installation's counts as external, including people
    // from another workspace of the same Enterprise Grid org.
    external: user.is_stranger === true || !homeTeam || (!!teamId && homeTeam !== teamId),
  };
}

/**
 * Where a Slack caller asked and who they are, read with the bot token. Throws when Slack can't
 * say, so no tool returns anything to a caller it couldn't place.
 */
export async function slackAudience(
  request: SlackRequest,
  input: { readonly channelId: string; readonly userId: string; readonly teamId?: string },
): Promise<SlackSearchAudience> {
  const team = input.teamId ?? "";
  const [sharedChannel, caller] = await Promise.all([
    remember(channelSharing, `${team}:${input.channelId}`, () =>
      isSharedChannel(request, input.channelId),
    ),
    remember(callerStatus, `${team}:${input.userId}`, () =>
      callerOf(request, input.userId, input.teamId),
    ),
  ]);
  return { channelId: input.channelId, sharedChannel, ...caller };
}
