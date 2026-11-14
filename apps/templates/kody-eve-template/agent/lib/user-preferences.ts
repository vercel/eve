import { createHash } from "node:crypto";

/**
 * Reserved Blob path prefix for per-user preference files.
 *
 * @remarks
 * The user-preferences tools own this prefix exclusively. Any general-purpose Blob tool must
 * treat it as off-limits (see `isReservedUserPath` / `isReservedUserUrl`) so it can't be used as
 * a side channel to read or overwrite another user's preferences — those files are only
 * reachable through the principal-scoped preference tools.
 */
export const USER_PREFERENCES_PREFIX = "user-preferences/";

/**
 * The current user's principal, as projected onto a tool's `ctx.session.auth.current`.
 *
 * @remarks
 * Structural subset of eve's `SessionAuthContext`; kept narrow so this module doesn't depend on
 * the full tool-context type.
 */
type UserPrincipal =
  | { readonly principalId: string; readonly principalType: string }
  | null
  | undefined;

/**
 * Whether a Blob pathname falls under the reserved user-preferences prefix.
 *
 * @param pathname - A Blob object pathname (no leading slash), e.g. `drafts/post.md`.
 * @returns `true` when the path is reserved for user preferences.
 */
export const isReservedUserPath = (pathname: string): boolean =>
  pathname.startsWith(USER_PREFERENCES_PREFIX);

/** Leading slashes stripped from a URL pathname before the reserved-prefix check. */
const LEADING_SLASHES = /^\/+/;

/**
 * Whether a Blob URL points at a reserved user-preferences object.
 *
 * @remarks
 * A public Blob URL embeds the object pathname as its URL path, so the reserved-prefix check
 * applies to the URL's pathname. Unparseable input is treated as not reserved; the caller's own
 * URL validation handles malformed URLs.
 *
 * @param url - A full Blob URL.
 * @returns `true` when the URL addresses a reserved user-preferences object.
 */
export const isReservedUserUrl = (url: string): boolean => {
  try {
    return isReservedUserPath(
      new URL(url).pathname.replace(LEADING_SLASHES, "")
    );
  } catch {
    return false;
  }
};

/**
 * Resolve the Blob key holding the current user's preferences.
 *
 * @remarks
 * The key is derived entirely from the framework-resolved principal — never from model input —
 * so a session can only ever read or write its own user's preferences. The principal id is
 * hashed so the stored path carries no raw user identifier. Only `principalType: "user"`
 * principals (a signed-in user on one of the channels) get a key; app/service/runtime callers return
 * `null` so the tools can decline rather than share a single anonymous file.
 *
 * @param principal - The value of `ctx.session.auth.current`.
 * @returns The reserved Blob key for this user, or `null` when there is no user principal.
 */
export const userPreferencesKey = (principal: UserPrincipal): string | null => {
  if (principal?.principalType !== "user" || !principal.principalId) {
    return null;
  }
  const id = createHash("sha256").update(principal.principalId).digest("hex");
  return `${USER_PREFERENCES_PREFIX}${id}.md`;
};
