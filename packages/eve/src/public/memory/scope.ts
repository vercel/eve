import type { MemoryScopeContext } from "#public/memory/index.js";
import { principalScope } from "#shared/principal-scope.js";

/**
 * A memory scope that gives each signed-in caller separate memory. It turns memory off for
 * anonymous and runtime callers, and returns one shared `local-dev` scope in local development.
 */
export function byPrincipal(context: MemoryScopeContext): string | null {
  return principalScope(context.session.auth);
}
