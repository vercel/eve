import type { SessionAuthContext } from "#context/keys.js";
import { isVercelDevelopmentUser } from "#runtime/connections/principal.js";

import type { ResolvedSelfModificationConfig } from "./config.js";

export function isLocalSelfModificationEnabled(config: ResolvedSelfModificationConfig): boolean {
  return process.env.EVE_DEV === "1" && config.localEnabled;
}

export function isLocalDeveloper(principal: SessionAuthContext | null): boolean {
  if (principal === null) return false;
  return principal.authenticator === "local-dev" || isVercelDevelopmentUser(principal);
}

export function isDeployedRuntime(): boolean {
  return process.env.EVE_DEV !== "1";
}
