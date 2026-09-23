import type { MemoryScopeContext } from "#public/memory/index.js";
import { principalScope } from "#shared/principal-scope.js";

export function byPrincipal(context: MemoryScopeContext): string | null {
  return principalScope(context.session.auth);
}
