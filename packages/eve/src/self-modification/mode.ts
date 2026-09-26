import type { ResolvedSelfModificationConfig } from "./config.js";

type SelfModificationMode = "local" | "disabled" | "deployed";

/** Resolves the mutually exclusive local or deployed editing mode. */
export function resolveSelfModificationMode(
  config: ResolvedSelfModificationConfig,
): SelfModificationMode {
  if (process.env.EVE_DEV === "1") return config.localEnabled ? "local" : "disabled";
  return config.deployed === undefined ? "disabled" : "deployed";
}
