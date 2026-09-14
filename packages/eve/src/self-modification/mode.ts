import type { ResolvedSelfModificationConfig } from "./config.js";

export type SelfModificationMode = "local" | "disabled" | "deployed";

/** Resolves the mutually exclusive local or deployed editing mode. */
export function resolveSelfModificationMode(
  config: ResolvedSelfModificationConfig,
): SelfModificationMode {
  if (process.env.EVE_DEV === "1") return config.localEnabled ? "local" : "disabled";
  if (config.deployed === undefined) return "disabled";
  if (
    config.deployed.credentials.kind === "vercel-connect" &&
    process.env.VERCEL_ENV !== "production"
  ) {
    return "disabled";
  }
  return "deployed";
}
