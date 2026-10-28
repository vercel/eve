import { createLogger, logError } from "#internal/logging.js";
import type { SlackWorkspaceHandle } from "#public/channels/slack/api.js";

const log = createLogger("slack.sender-profiles");

/** Model-visible Slack profile fields for one sender. */
export interface SlackSenderProfile {
  /** Rendered as `name` in the message's `<sender>` block. */
  readonly name?: string;
  /** Rendered as `email` in the message's `<sender>` block. */
  readonly email?: string;
}

/** Input to a {@link SlackSenderProfileLookup}. */
export interface SlackSenderProfileLookupInput {
  /** Slack user id of the sender. */
  readonly userId: string;
  /**
   * Workspace whose app installation received the message, falling back to the
   * message's team. Include it in cache keys: user ids are scoped to it.
   */
  readonly teamId: string | undefined;
  /** Workspace-scoped Slack API handle, authorized with the channel's bot token. */
  readonly slack: SlackWorkspaceHandle;
}

/**
 * Returns the profile for one Slack sender, or `undefined` to leave the
 * `<sender>` block without `name` and `email`. A thrown error is logged and
 * treated as `undefined`; the message is still delivered.
 */
export type SlackSenderProfileLookup = (
  input: SlackSenderProfileLookupInput,
) => Promise<SlackSenderProfile | undefined>;

/** Sender profiles keyed by Slack user id. */
export type SlackSenderProfiles = ReadonlyMap<string, SlackSenderProfile>;

/**
 * Fetches one sender's profile with Slack's `users.info`, uncached. `name` is
 * the display name, falling back to the real name; `email` is present only
 * with the `users:read.email` scope. Throws when Slack rejects the call, so a
 * caching lookup can tell a failure from an empty profile.
 */
export async function fetchSlackSenderProfile(input: {
  readonly userId: string;
  readonly slack: Pick<SlackWorkspaceHandle, "request">;
}): Promise<SlackSenderProfile> {
  const response = await input.slack.request("users.info", { user: input.userId });
  if (response.ok !== true) {
    const error = typeof response.error === "string" ? response.error : "unknown_error";
    throw new Error(
      error === "missing_scope"
        ? "Slack users.info failed with missing_scope: add the users:read scope (and users:read.email for emails), then reinstall the Slack app."
        : `Slack users.info failed with ${error}.`,
    );
  }
  return profileFromUser(response.user);
}

const PROFILE_TTL_MS = 60 * 60 * 1000;
/** A failed lookup is retried after this, so a blip doesn't hide a name for an hour. */
const FAILED_LOOKUP_TTL_MS = 60_000;
const MAX_CACHED_PROFILES = 1000;
// Bounds the lookups one inbound message can trigger.
const MAX_LOOKUPS_PER_MESSAGE = 20;

interface CachedProfile {
  readonly expiresAt: number;
  readonly profile: Promise<SlackSenderProfile | undefined>;
}

/**
 * The lookup `senderProfiles: true` uses: {@link fetchSlackSenderProfile} behind
 * an in-memory cache keyed by workspace and user. Each Slack channel owns one,
 * so a profile fetched with one app's scopes never reaches another app in the
 * same process. Profiles are kept for an hour; a failure is logged once and
 * retried after a minute.
 */
export function createCachedSlackSenderProfileLookup(
  now: () => number = Date.now,
): SlackSenderProfileLookup {
  const cache = new Map<string, CachedProfile>();

  return ({ userId, teamId, slack }) => {
    const key = `${teamId ?? ""}:${userId}`;
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > now()) return cached.profile;

    cache.delete(key);
    if (cache.size >= MAX_CACHED_PROFILES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const startedAt = now();
    const profile: Promise<SlackSenderProfile | undefined> = fetchSlackSenderProfile({
      userId,
      slack,
    }).catch((error: unknown) => {
      logError(log, "sender profile lookup failed; omitting it", error, { userId });
      if (cache.get(key)?.profile === profile) {
        cache.set(key, { expiresAt: startedAt + FAILED_LOOKUP_TTL_MS, profile });
      }
      return undefined;
    });
    cache.set(key, { expiresAt: startedAt + PROFILE_TTL_MS, profile });
    return profile;
  };
}

/**
 * Runs `lookup` for each distinct sender, the first
 * {@link MAX_LOOKUPS_PER_MESSAGE} only. Never throws: a failed or empty lookup
 * leaves that sender out of the map.
 */
export async function resolveSlackSenderProfiles(input: {
  readonly lookup: SlackSenderProfileLookup;
  readonly slack: SlackWorkspaceHandle;
  readonly teamId: string | undefined;
  readonly userIds: readonly string[];
}): Promise<SlackSenderProfiles> {
  const userIds = [...new Set(input.userIds)].slice(0, MAX_LOOKUPS_PER_MESSAGE);
  const entries = await Promise.all(
    userIds.map(async (userId) => {
      try {
        const profile = await input.lookup({ userId, teamId: input.teamId, slack: input.slack });
        return profile === undefined ? [] : [[userId, profile] as const];
      } catch (error) {
        logError(log, "sender profile lookup threw; omitting it", error, { userId });
        return [];
      }
    }),
  );
  return new Map(entries.flat());
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
