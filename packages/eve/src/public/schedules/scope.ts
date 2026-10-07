import type { ScheduleScopeContext } from "#public/schedules/subscription.js";
import { principalScope } from "#shared/principal-scope.js";

export function byPrincipal(context: ScheduleScopeContext): string | null {
  return principalScope(context.session.auth);
}
