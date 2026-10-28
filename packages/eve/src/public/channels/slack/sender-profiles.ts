import { createLogger, logError } from "#internal/logging.js";
import type { SlackRequest } from "#public/channels/slack/code-channel.js";

const log = createLogger("slack.sender-profiles");

/** Model-visible Slack profile fields for one sender. */
export interface SlackSenderProfile {
  readonly name?: string;
  readonly email?: string;
}

/** Sender profiles keyed by Slack user id. */
export type SlackSenderProfiles = ReadonlyMap<string, SlackSenderProfile>;

/** Resolves profiles for `userIds` in one workspace. Never throws. */
export type SlackSenderProfileResolver = (input: {
  readonly request: SlackRequest;
  readonly teamId: string | undefined;
  readonly userIds: readonly string[];
}) => Promise<SlackSenderProfiles>;

const PROFILE_TTL_MS = 60 * 60 * 1000;
/** A failed lookup is retried after this, so a blip doesn't hide a name for an hour. */
const FAILED_LOOKUP_TTL_MS = 60_000;
const MAX_CACHED_PROFILES = 1000;
// Bounds the users.info calls one inbound message can trigger.
const MAX_LOOKUPS_PER_MESSAGE = 20;

interface CachedProfile {
  readonly expiresAt: number;
  readonly profile: Promise<SlackSenderProfile>;
}

/**
 * Creates a `users.info` resolver with its own cache, keyed by workspace and
 * user. Each Slack channel owns one, so a profile fetched with one app's
 * scopes never reaches another app in the same process. Profiles are kept for
 * an hour; a failed lookup resolves to an empty profile and is retried after a
 * minute.
 */
export function createSlackSenderProfileResolver(
  now: () => number = Date.now,
): SlackSenderProfileResolver {
  const cache = new Map<string, CachedProfile>();

  function cachedProfile(
    request: SlackRequest,
    teamId: string | undefined,
    userId: string,
  ): Promise<SlackSenderProfile> {
    const key = `${teamId ?? ""}:${userId}`;
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > now()) return cached.profile;

    cache.delete(key);
    if (cache.size >= MAX_CACHED_PROFILES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const startedAt = now();
    const profile: Promise<SlackSenderProfile> = fetchProfile(request, userId).then((result) => {
      if (result !== undefined) return result;
      if (cache.get(key)?.profile === profile) {
        cache.set(key, { expiresAt: startedAt + FAILED_LOOKUP_TTL_MS, profile });
      }
      return {};
    });
    cache.set(key, { expiresAt: startedAt + PROFILE_TTL_MS, profile });
    return profile;
  }

  return async ({ request, teamId, userIds }) => {
    const unique = [...new Set(userIds)].slice(0, MAX_LOOKUPS_PER_MESSAGE);
    const entries = await Promise.all(
      unique.map(async (userId) => [userId, await cachedProfile(request, teamId, userId)] as const),
    );
    return new Map(entries);
  };
}

/** Returns the sender's profile, or `undefined` when the lookup failed. */
async function fetchProfile(
  request: SlackRequest,
  userId: string,
): Promise<SlackSenderProfile | undefined> {
  try {
    const response = await request("users.info", { user: userId });
    if (response.ok !== true) {
      log.warn(
        response.error === "missing_scope"
          ? "users.info needs the users:read scope (and users:read.email for emails) to add sender profiles; reinstall the Slack app"
          : "users.info failed; omitting the sender profile",
        { error: response.error, userId },
      );
      return undefined;
    }
    return profileFromUser(response.user);
  } catch (error) {
    logError(log, "users.info threw; omitting the sender profile", error, { userId });
    return undefined;
  }
}

function profileFromUser(user: unknown): SlackSenderProfile {
  if (typeof user !== "object" || user === null) return {};
  const record = user as Record<string, unknown>;
  const profile =
    typeof record.profile === "object" && record.profile !== null
      ? (record.profile as Record<string, unknown>)
      : {};
  const name =
    nonEmpty(profile.display_name) ?? nonEmpty(profile.real_name) ?? nonEmpty(record.real_name);
  const email = nonEmpty(profile.email);
  return { ...(name && { name }), ...(email && { email }) };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
