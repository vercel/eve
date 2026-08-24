import type { ResolvedSelfModificationConfig } from "./config.js";

export type SelfModificationMode = "development" | "disabled" | "pull-requests";

/** Resolves the applicable self-modification capability for this runtime. */
export function resolveSelfModificationMode(
  config: ResolvedSelfModificationConfig,
): SelfModificationMode {
  if (process.env.EVE_DEV === "1") {
    return config.developmentEnabled ? "development" : "disabled";
  }
  return config.pullRequests === undefined ? "disabled" : "pull-requests";
}
