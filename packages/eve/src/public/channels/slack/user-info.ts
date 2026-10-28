import { createLogger, logError } from "#internal/logging.js";
import type { SlackRequest } from "#public/channels/slack/code-channel.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";

const log = createLogger("slack.user-info");

/** Slack profile fields `messageContext.users` adds to a message's sender. */
export interface SlackUserInfo {
  /** Rendered as `sender_display_name`. */
  readonly displayName?: string;
  /** Rendered as `sender_real_name`, and set as `message.author.fullName`. */
  readonly realName?: string;
  /** Rendered as `sender_email`. Kept only with `messageContext.users.email`. */
  readonly email?: string;
}

/** The `messageContext.users` option of `slackChannel()`. */
export type SlackUsersOption =
  | boolean
  | {
      /** Adds each sender's email. Needs the `users:read.email` scope. */
      readonly email?: boolean;
      /**
       * Resolves one user, for example from your own cache. `next()` is eve's
       * uncached `users.info` call and throws when Slack rejects it. Return
       * `undefined` to leave the user's profile fields out.
       */
      readonly resolve?: (
        user: {
          readonly userId: string;
          /**
           * Workspace whose app installation received the message, falling
           * back to the message's team: `message.installationTeamId ??
           * message.teamId`. Slack user ids are scoped to it, so key caches on
           * it rather than on `message.teamId`.
           */
          readonly teamId: string | undefined;
        },
        next: () => Promise<SlackUserInfo>,
      ) => Promise<SlackUserInfo | undefined>;
    };

/** Looks up Slack users for one channel. Never throws; a failure resolves to `undefined`. */
export type SlackUserResolver = (input: {
  readonly userId: string;
  readonly teamId: string | undefined;
  readonly request: SlackRequest;
}) => Promise<SlackUserInfo | undefined>;

const PROFILE_TTL_MS = 60 * 60 * 1000;
/** A failed lookup is retried after this, so a blip doesn't hide a name for an hour. */
const FAILED_LOOKUP_TTL_MS = 60_000;
const MAX_CACHED_PROFILES = 1000;
/** Profiles are optional, so a lookup that never settles must not hold the message. */
const LOOKUP_TIMEOUT_MS = 2000;
// Bounds the lookups one inbound message can trigger.
const MAX_LOOKUPS_PER_MESSAGE = 20;

interface CachedProfile {
  readonly expiresAt: number;
  readonly profile: Promise<SlackUserInfo | undefined>;
}

/**
 * Builds the resolver for `messageContext.users`, or `undefined` when it is
 * off. Without an authored `resolve`, `users.info` results are cached in
 * memory per workspace and user for an hour, and failures for a minute. Each
 * Slack channel builds its own, so a profile fetched with one app's scopes
 * never reaches another app in the same process.
 */
export function createSlackUserResolver(
  option: SlackUsersOption | undefined,
  now: () => number = Date.now,
): SlackUserResolver | undefined {
  if (option === undefined || option === false) return undefined;
  const includeEmail = option !== true && option.email === true;
  const authored = option === true ? undefined : option.resolve;
  const cache = new Map<string, CachedProfile>();

  const cached: SlackUserResolver = ({ userId, teamId, request }) => {
    const key = `${teamId ?? ""}:${userId}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.expiresAt > now()) return hit.profile;

    cache.delete(key);
    if (cache.size >= MAX_CACHED_PROFILES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const startedAt = now();
    const profile: Promise<SlackUserInfo | undefined> = fetchSlackUserInfo(userId, request).catch(
      (error: unknown) => {
        logError(log, "Slack user lookup failed; omitting it", error, { userId });
        if (cache.get(key)?.profile === profile) {
          cache.set(key, { expiresAt: startedAt + FAILED_LOOKUP_TTL_MS, profile });
        }
        return undefined;
      },
    );
    cache.set(key, { expiresAt: startedAt + PROFILE_TTL_MS, profile });
    return profile;
  };

  const lookup: SlackUserResolver =
    authored === undefined
      ? cached
      : ({ userId, teamId, request }) =>
          authored({ userId, teamId }, () => fetchSlackUserInfo(userId, request));

  return async (input) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const profile = await Promise.race([
        lookup(input),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            log.warn("Slack user lookup timed out; omitting it", { userId: input.userId });
            resolve(undefined);
          }, LOOKUP_TIMEOUT_MS);
        }),
      ]);
      if (profile === undefined || includeEmail) return profile;
      const { email: _email, ...withoutEmail } = profile;
      return withoutEmail;
    } catch (error) {
      logError(log, "Slack user lookup threw; omitting it", error, { userId: input.userId });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Resolves each distinct user, the first {@link MAX_LOOKUPS_PER_MESSAGE} only.
 * A failed or empty lookup leaves that user out of the map.
 */
export async function resolveSlackUsers(
  resolver: SlackUserResolver,
  input: {
    readonly userIds: readonly string[];
    readonly teamId: string | undefined;
    readonly request: SlackRequest;
  },
): Promise<ReadonlyMap<string, SlackUserInfo>> {
  const userIds = [...new Set(input.userIds)].slice(0, MAX_LOOKUPS_PER_MESSAGE);
  const entries = await Promise.all(
    userIds.map(async (userId) => {
      const profile = await resolver({ userId, teamId: input.teamId, request: input.request });
      return profile === undefined ? [] : [[userId, profile] as const];
    }),
  );
  return new Map(entries.flat());
}

/** Returns `message` with its human author's resolved profile fields, or unchanged. */
export async function withSlackUserInfo(
  message: SlackMessage,
  resolver: SlackUserResolver,
  input: { readonly teamId: string | undefined; readonly request: SlackRequest },
): Promise<SlackMessage> {
  const author = message.author;
  if (author === undefined || author.isBot) return message;
  const info = await resolver({ userId: author.userId, ...input });
  if (info === undefined) return message;
  return {
    ...message,
    author: {
      ...author,
      fullName: info.realName ?? author.fullName,
      ...(info.displayName && { displayName: info.displayName }),
      ...(info.email && { email: info.email }),
    },
  };
}

/** Calls Slack's `users.info`. Throws when Slack rejects the call. */
async function fetchSlackUserInfo(userId: string, request: SlackRequest): Promise<SlackUserInfo> {
  const response = await request("users.info", { user: userId });
  if (response.ok !== true) {
    const error = typeof response.error === "string" ? response.error : "unknown_error";
    throw new Error(
      error === "missing_scope"
        ? "Slack users.info failed with missing_scope: add the users:read scope (and users:read.email for emails), then reinstall the Slack app."
        : `Slack users.info failed with ${error}.`,
    );
  }
  return userInfoFromSlack(response.user);
}

function userInfoFromSlack(user: unknown): SlackUserInfo {
  if (typeof user !== "object" || user === null) return {};
  const record = user as Record<string, unknown>;
  const profile =
    typeof record.profile === "object" && record.profile !== null
      ? (record.profile as Record<string, unknown>)
      : {};
  const displayName = nonEmpty(profile.display_name);
  const realName = nonEmpty(profile.real_name) ?? nonEmpty(record.real_name);
  const email = nonEmpty(profile.email);
  return {
    ...(displayName && { displayName }),
    ...(realName && { realName }),
    ...(email && { email }),
  };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
