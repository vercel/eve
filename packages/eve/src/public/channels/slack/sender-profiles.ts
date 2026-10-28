import { createLogger } from "#internal/logging.js";
import type { SlackApiResponse } from "#public/channels/slack/api.js";

const log = createLogger("slack.sender-profiles");

/** Model-visible Slack profile fields for one sender. */
export interface SlackSenderProfile {
  readonly name?: string;
  readonly email?: string;
}

type SlackRequest = (operation: string, body: unknown) => Promise<SlackApiResponse>;

const PROFILE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_PROFILES = 1000;
// Bounds the users.info calls one inbound message can trigger.
const MAX_LOOKUPS_PER_MESSAGE = 20;

interface CachedProfile {
  readonly expiresAt: number;
  readonly profile: Promise<SlackSenderProfile>;
}

const cache = new Map<string, CachedProfile>();

/**
 * Resolves Slack profiles for `userIds` in one workspace with `users.info`.
 * Results, including failed lookups, are cached per workspace and user for an
 * hour so a missing `users:read` scope costs one call per user, not one per
 * message. A failed lookup resolves to an empty profile; it never throws.
 */
export async function resolveSlackSenderProfiles(input: {
  readonly request: SlackRequest;
  readonly teamId: string | undefined;
  readonly userIds: readonly string[];
  readonly now?: number;
}): Promise<ReadonlyMap<string, SlackSenderProfile>> {
  const now = input.now ?? Date.now();
  const userIds = [...new Set(input.userIds)].slice(0, MAX_LOOKUPS_PER_MESSAGE);
  const entries = await Promise.all(
    userIds.map(async (userId) => {
      const profile = await cachedProfile(input.request, input.teamId, userId, now);
      return [userId, profile] as const;
    }),
  );
  return new Map(entries);
}

function cachedProfile(
  request: SlackRequest,
  teamId: string | undefined,
  userId: string,
  now: number,
): Promise<SlackSenderProfile> {
  const key = `${teamId ?? ""}:${userId}`;
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.profile;

  cache.delete(key);
  if (cache.size >= MAX_CACHED_PROFILES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const profile = fetchProfile(request, userId);
  cache.set(key, { expiresAt: now + PROFILE_TTL_MS, profile });
  return profile;
}

async function fetchProfile(request: SlackRequest, userId: string): Promise<SlackSenderProfile> {
  try {
    const response = await request("users.info", { user: userId });
    if (!response.ok) {
      log.warn("slack users.info failed", { error: response.error, userId });
      return {};
    }
    return profileFromUser(response.user);
  } catch (error) {
    log.warn("slack users.info failed", { error, userId });
    return {};
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

/** Clears the profile cache. Test-only. */
export function clearSlackSenderProfileCache(): void {
  cache.clear();
}
