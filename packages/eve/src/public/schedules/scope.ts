import type { ScheduleScopeContext } from "#public/schedules/subscription.js";
import { principalScope } from "#shared/principal-scope.js";

/**
 * The default dynamic schedule scope: each signed-in caller manages only their own schedules. It
 * denies anonymous and runtime callers, and uses one shared `local-dev` scope in local development.
 */
export function byPrincipal(context: ScheduleScopeContext): string | null {
  return principalScope(context.session.auth);
}
