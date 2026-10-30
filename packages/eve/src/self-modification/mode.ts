import type { SessionAuthContext } from "#context/keys.js";
import { isVercelDevelopmentUser } from "#runtime/connections/principal.js";

import type { ResolvedSelfModificationConfig } from "./config.js";

/** Local self-modification runs only inside the development runtime. */
export function isLocalSelfModificationEnabled(config: ResolvedSelfModificationConfig): boolean {
  return process.env.EVE_DEV === "1" && config.localEnabled;
}

/**
 * Whether the caller is the developer running `eve dev`: the `localDev()`
 * principal, or the Vercel user whose development token the dev TUI sends for
 * a linked project. Other authenticated callers, such as chat users reaching
 * the server through a tunnel, must not edit the developer's authored source.
 */
export function isLocalDeveloper(principal: SessionAuthContext | null): boolean {
  if (principal === null) return false;
  return principal.authenticator === "local-dev" || isVercelDevelopmentUser(principal);
}

/** Deployed self-modification is offered only outside the development runtime. */
export function isDeployedRuntime(): boolean {
  return process.env.EVE_DEV !== "1";
}
