import type { SessionAuthContext } from "eve/context";

import { resolveAnalystRole } from "#lib/analyst/access";
import type { RoleResolution } from "#lib/analyst/access";
import { defineState } from "#lib/state";

interface ThreadRoles {
  /** Roles whose query results or schema listings are in this session's history. */
  readonly roles: readonly string[];
}

const threadRoles = defineState<ThreadRoles>("analyst.thread-roles", () => ({
  roles: [],
}));

/**
 * Names of the tools whose results carry data fetched as the caller's role.
 *
 * @remarks eve names tools after their files, so renaming `agent/tools/run_sql.ts` or `agent/tools/describe_schema.ts` must update this list, or the thread role guard stops recording roles.
 */
export const ROLE_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "describe_schema",
  "run_sql",
]);

/* The caller's role, or null when settings are invalid; tools report those errors themselves. */
const safeResolve = (
  auth: SessionAuthContext | null
): RoleResolution | null => {
  try {
    return resolveAnalystRole(auth);
  } catch {
    return null;
  }
};

/**
 * Records that this session's history now holds results fetched as the caller's role.
 *
 * @param auth - The caller whose tool call just succeeded.
 * @remarks Does nothing when the caller has no access or settings are invalid, since the tool can't have fetched anything then.
 */
export const recordThreadRole = (auth: SessionAuthContext | null): void => {
  const access = safeResolve(auth);
  if (!access?.ok) {
    return;
  }
  const { role } = access;
  threadRoles.update((current) =>
    current.roles.includes(role)
      ? current
      : { ...current, roles: [...current.roles, role] }
  );
};

/**
 * Checks whether a caller would see results that earlier turns fetched as another role.
 *
 * @param auth - The current caller.
 * @returns True when the session holds results from a role other than the caller's, or the caller has no access and any role is recorded.
 * @remarks Roles aren't ordered, so only the same role is safe. Invalid settings return false, and the tools report them when they run. The Slack renderer checks this again when a turn is cancelled, because state a hook writes just before `ctx.cancel()` isn't kept.
 */
export const conflictsWithThreadRoles = (
  auth: SessionAuthContext | null
): boolean => {
  const { roles } = threadRoles.get();
  if (roles.length === 0) {
    return false;
  }
  const access = safeResolve(auth);
  if (access === null) {
    return false;
  }
  return !access.ok || roles.some((role) => role !== access.role);
};
