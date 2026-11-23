import { contextScopeValue, withContextScopeValue } from "#context/container.js";
import type { SessionAuth } from "#context/keys.js";

const DISABLED_PRINCIPAL_TYPES = new Set(["anonymous", "runtime"]);
const PRINCIPAL_SCOPE_TRACKER = Symbol.for("eve.principalScopeTracker");

interface PrincipalScopeTracker {
  used: boolean;
}

export async function trackPrincipalScope<T>(
  run: () => T | Promise<T>,
): Promise<{ readonly value: T; readonly used: boolean }> {
  const tracker: PrincipalScopeTracker = { used: false };
  const value = await withContextScopeValue(PRINCIPAL_SCOPE_TRACKER, tracker, run);
  return { value, used: tracker.used };
}

export function principalScope(auth: SessionAuth): string | null {
  const principal = auth.current;
  if (principal === null || DISABLED_PRINCIPAL_TYPES.has(principal.principalType)) return null;
  const tracker = contextScopeValue<PrincipalScopeTracker>(PRINCIPAL_SCOPE_TRACKER);
  if (tracker !== undefined) tracker.used = true;
  if (principal.principalType === "local-dev") return "local-dev";
  return JSON.stringify([
    principal.principalType,
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalId,
  ]);
}
