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
 * The caller's own skills, which follow them into every conversation. Absent
 * for anonymous callers. A scheduled run gets the personal scope of the
 * principal it runs as.
 */
export function personalScope(ctx: SkillScopeContext): SkillScope | null {
  const auth = ctx.session.auth.current;
  if (!auth || !auth.principalId || auth.principalType === "anonymous") return null;
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

export function requireScope(
  scopes: readonly SkillScope[],
  requested: string | undefined,
): SkillScope {
  const scope =
    requested === undefined ? scopes[0] : scopes.find((candidate) => candidate.name === requested);
  if (scope) return scope;
  const available = scopes.map((candidate) => candidate.name);
  throw new SkillScopeUnavailableError(
    available.length === 0
      ? "Could not determine who is calling, so no skill scope is available."
      : `The "${requested}" skill scope is not available here. Available scopes: ${available.join(", ")}.`,
  );
}
