import type { SessionAuth } from "#context/keys.js";

const DISABLED_PRINCIPAL_TYPES = new Set(["anonymous", "runtime"]);

export function principalScope(auth: SessionAuth): string | null {
  const principal = auth.current;
  if (principal === null || DISABLED_PRINCIPAL_TYPES.has(principal.principalType)) return null;
  if (principal.principalType === "local-dev") return "local-dev";
  return JSON.stringify([
    principal.principalType,
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalId,
  ]);
}
