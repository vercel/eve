import type { ScheduleScopeContext } from "#public/schedules/collection.js";

const DISABLED_PRINCIPAL_TYPES = new Set(["anonymous", "runtime"]);

export function byPrincipal(context: ScheduleScopeContext): string | null {
  const principal = context.session.auth.current;
  if (principal === null || DISABLED_PRINCIPAL_TYPES.has(principal.principalType)) return null;
  if (principal.principalType === "local-dev") return "local-dev";
  return JSON.stringify([
    principal.principalType,
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalId,
  ]);
}
