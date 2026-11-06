import { SkillScopeUnavailableError } from "./errors.ts";
import type { SkillAuth, SkillScope } from "./types.ts";
import { pathSafe } from "./validation.ts";

/**
 * The owners whose skills apply for `auth`, in precedence order. The first
 * scope is the default for lifecycle tools.
 */
export type SkillScopeResolver = (auth: SkillAuth | null | undefined) => readonly SkillScope[];

export const CHANNEL_SKILL_PREFIX = "channel-";

function attribute(auth: SkillAuth | null | undefined, key: string): string | undefined {
  const value = auth?.attributes?.[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0]) return value[0];
  return undefined;
}

function callerLabel(auth: SkillAuth | null | undefined): string | undefined {
  return attribute(auth, "email") ?? attribute(auth, "user_id") ?? auth?.principalId;
}

/** The caller's private skills, keyed by their eve principal. */
export function personalScope(auth: SkillAuth | null | undefined): SkillScope | null {
  const principalId = auth?.principalId?.trim();
  if (!principalId) return null;
  return {
    scope: "personal",
    ownerKey: pathSafe(principalId),
    ownerLabel: callerLabel(auth) ?? principalId,
    loadNamePrefix: "",
    title: "personal",
    requester: "the user",
    setBy: "The authenticated user",
  };
}

/**
 * Skills shared by everyone in the Slack channel the message came from, read
 * from the `channel_id` and `team_id` attributes eve's Slack channel sets.
 * DMs have no channel scope.
 */
export function slackChannelScope(auth: SkillAuth | null | undefined): SkillScope | null {
  const channelId = attribute(auth, "channel_id");
  if (!channelId || /^d/i.test(channelId)) return null;
  const teamId = attribute(auth, "team_id");
  const principal = teamId ? `channel:${teamId}:${channelId}` : `channel:${channelId}`;
  return {
    scope: "channel",
    ownerKey: pathSafe(principal),
    ownerLabel: callerLabel(auth) ?? "unknown",
    loadNamePrefix: CHANNEL_SKILL_PREFIX,
    title: "channel",
    requester: "someone in this Slack channel",
    setBy: "Members of this Slack channel",
  };
}

/** Personal skills everywhere, plus channel skills inside a Slack channel. */
export const defaultScopeResolver: SkillScopeResolver = (auth) =>
  [personalScope(auth), slackChannelScope(auth)].filter(
    (scope): scope is SkillScope => scope !== null,
  );

export function requireScope(
  scopes: readonly SkillScope[],
  requested: string | undefined,
): SkillScope {
  const scope =
    requested === undefined ? scopes[0] : scopes.find((candidate) => candidate.scope === requested);
  if (scope) return scope;
  const available = scopes.map((candidate) => candidate.scope);
  throw new SkillScopeUnavailableError(
    available.length === 0
      ? "Could not determine who is calling, so no skill scope is available."
      : `The "${requested}" skill scope is not available here. Available scopes: ${available.join(", ")}.`,
  );
}
