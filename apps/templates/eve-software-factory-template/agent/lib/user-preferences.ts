import { createHash } from "node:crypto";
import { USER_PREFERENCES_PREFIX } from "./blob.js";

/**
 * Key derivation for per-user preference files.
 *
 * @remarks
 * Preference files live under the reserved `user-preferences/` prefix, owned by the
 * principal-scoped preference tools. The prefix and its guards come from the reserved-namespace
 * registry in `./blob.js`, which is what keeps any general-purpose Blob tool from using the
 * namespace as a side channel to read or overwrite another user's preferences.
 */

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
