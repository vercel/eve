import type { SessionAuthContext } from "#channel/types.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";
import { isObject } from "#shared/guards.js";

const SUCCESS_TTL_MS = 15 * 60 * 1_000;
const FAILURE_TTL_MS = 60 * 1_000;

interface CachedDisplayName {
  readonly displayName: string | undefined;
  readonly expiresAt: number;
}

const profileCache = new Map<string, CachedDisplayName>();
const pendingProfiles = new Map<string, Promise<string | undefined>>();

/** Clears process-local Slack profile state between tests. */
export function clearSlackUserProfileCacheForTests(): void {
  profileCache.clear();
  pendingProfiles.clear();
}

/**
 * Best-effort enrichment for accepted Slack webhook auth. Profile lookup starts
 * only after the authored inbound handler accepts the message, and warm-process
 * results are cached by workspace and user.
 */
export async function enrichSlackUserAuth(input: {
  readonly auth: SessionAuthContext | null;
  readonly botToken: SlackBotToken | undefined;
  readonly teamId: string | undefined;
}): Promise<SessionAuthContext | null> {
  const { auth } = input;
  if (
    auth?.authenticator !== "slack-webhook" ||
    auth.principalType !== "user" ||
    typeof auth.attributes.display_name === "string"
  ) {
    return auth;
  }

  const userId = auth.attributes.user_id;
  if (typeof userId !== "string" || userId.length === 0) return auth;

  const displayName = await resolveSlackUserDisplayName({
    botToken: input.botToken,
    teamId: input.teamId,
    userId,
  });
  if (displayName === undefined) return auth;

  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      display_name: displayName,
    },
  };
}

async function resolveSlackUserDisplayName(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly teamId: string | undefined;
  readonly userId: string;
}): Promise<string | undefined> {
  const key = `${input.teamId ?? "slack"}:${input.userId}`;
  const cached = profileCache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.displayName;

  const pending = pendingProfiles.get(key);
  if (pending !== undefined) return pending;

  const request = fetchSlackUserDisplayName(input)
    .then((displayName) => {
      profileCache.set(key, {
        displayName,
        expiresAt: Date.now() + (displayName === undefined ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
      });
      return displayName;
    })
    .finally(() => pendingProfiles.delete(key));
  pendingProfiles.set(key, request);
  return request;
}

async function fetchSlackUserDisplayName(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly userId: string;
}): Promise<string | undefined> {
  try {
    const response = await callSlackApi({
      body: { user: input.userId },
      botToken: input.botToken,
      operation: "users.info",
    });
    if (response.ok !== true || !isObject(response.user)) return undefined;

    const profile = isObject(response.user.profile) ? response.user.profile : undefined;
    return firstNonEmptyString(
      profile?.display_name,
      profile?.real_name,
      response.user.real_name,
      response.user.name,
    );
  } catch {
    return undefined;
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}
