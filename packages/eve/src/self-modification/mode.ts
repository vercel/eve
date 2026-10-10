import type { ResolvedSelfModificationConfig } from "./config.js";

/** Local self-modification runs only inside the development runtime. */
export function isLocalSelfModificationEnabled(config: ResolvedSelfModificationConfig): boolean {
  return process.env.EVE_DEV === "1" && config.localEnabled;
}

/** Deployed self-modification is offered only outside the development runtime. */
export function isDeployedRuntime(): boolean {
  return process.env.EVE_DEV !== "1";
}
