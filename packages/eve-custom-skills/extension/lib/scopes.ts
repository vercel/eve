import type { SessionAuthContext } from "eve/context";

import { SkillScopeUnavailableError } from "./errors.ts";
import type { SkillAuthor, SkillScope, SkillScopeContext, SkillScopeResolver } from "./types.ts";

function attribute(auth: SessionAuthContext | null, key: string): string | undefined {
  const value = auth?.attributes?.[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0]) return value[0];
  return undefined;
}

/** Who a session acts for, as a version records it. */
export function skillAuthor(auth: SessionAuthContext | null): SkillAuthor {
  const principalId = auth?.principalId?.trim() || null;
  const label =
    attribute(auth, "email") ??
    attribute(auth, "user_name") ??
    attribute(auth, "username") ??
    principalId ??
    "unknown";
  return { principalId, label };
}

/**
 * Principals that act for nobody in particular: anonymous callers, and eve's
 * own runtime, such as a schedule that runs as the app. Every such run would
 * share one personal scope, so a skill saved in one would apply to all.
 */
const IMPERSONAL_PRINCIPAL_TYPES = new Set(["anonymous", "runtime"]);

/**
 * The caller's own skills, which follow them into every conversation. Absent
 * for anonymous callers and runtime principals. A scheduled run that runs as
 * a person gets that person's personal scope.
 */
export function personalScope(ctx: SkillScopeContext): SkillScope | null {
  const auth = ctx.session.auth.current;
  if (!auth || !auth.principalId || IMPERSONAL_PRINCIPAL_TYPES.has(auth.principalType)) {
    return null;
  }
  return {
    name: "personal",
    // eve's full principal identity, exact: two principals that differ in any field never share skills.
    key: `user:${JSON.stringify([
      auth.authenticator,
      auth.issuer ?? "",
      auth.principalType,
      auth.principalId,
      auth.subject ?? "",
    ])}`,
    label: "you",
    shared: false,
  };
}

/**
 * The skills everyone in the conversation's place shares, such as a Slack
 * channel or a group chat, from the channel's `ctx.conversation.space`.
 * Absent in direct conversations and on channels that report no space.
 */
export function spaceScope(ctx: SkillScopeContext): SkillScope | null {
  const space = ctx.conversation?.space;
  if (!space || space.type === "direct") return null;
  return {
    name: "channel",
    key: `space:${space.id}`,
    label: space.type === "group" ? "everyone in this conversation" : "everyone in this channel",
    shared: true,
    loadPrefix: "channel",
  };
}

/** Personal skills everywhere, plus the shared skills of the conversation's channel or group. */
export const defaultScopes: SkillScopeResolver = (ctx) =>
  [personalScope(ctx), spaceScope(ctx)].filter((scope): scope is SkillScope => scope !== null);

/**
 * The scope a tool acts on: the one it names, or else the first scope that
 * isn't shared, since omitting the scope means the caller's own skills. A
 * caller with no personal scope must name a shared one, so a change meant for
 * themselves never lands where everyone sees it.
 */
export function requireScope(
  scopes: readonly SkillScope[],
  requested: string | undefined,
): SkillScope {
  const scope =
    requested === undefined
      ? scopes.find((candidate) => !candidate.shared)
      : scopes.find((candidate) => candidate.name === requested);
  if (scope) return scope;
  const available = scopes.map((candidate) => candidate.name);
  if (available.length === 0) {
    throw new SkillScopeUnavailableError(
      "Could not determine who is calling, so no skill scope is available.",
    );
  }
  throw new SkillScopeUnavailableError(
    requested === undefined
      ? `There are no personal skills here. Pass \`scope\` to act on a shared scope: ${available.join(", ")}.`
      : `The "${requested}" skill scope is not available here. Available scopes: ${available.join(", ")}.`,
  );
}
