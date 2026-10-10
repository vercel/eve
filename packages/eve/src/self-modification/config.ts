import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "#public/index.js";

export const DEPLOYED_OPTION_MOVED_MESSAGE =
  "The `deployed` option moved to the separate `eve/self-modification/remote` mount. Remove it from this local self-modification mount and mount `eve/self-modification/remote` instead.";

/** Local self-modification settings shared by its bundled child and sandbox. */
export interface SelfModificationConfig {
  readonly local?: { readonly enabled?: boolean };
}

/** Values accepted by the local self-modification extension mount. */
export interface SelfModificationExtensionConfig extends SelfModificationConfig {
  readonly model?: AgentStaticModelDefinition;
  readonly reasoning?: AgentReasoningDefinition;
}

export interface ResolvedSelfModificationConfig {
  readonly localEnabled: boolean;
}

/** Defines the local self-modification policy. */
export function defineSelfModificationConfig(
  config: SelfModificationConfig = {},
): SelfModificationConfig {
  resolveSelfModificationConfig(config);
  return config;
}

export function resolveSelfModificationConfig(
  config: SelfModificationConfig = {},
): ResolvedSelfModificationConfig {
  if (!isRecord(config)) throw new Error("Self-modification configuration must be an object.");
  if ("deployed" in config) throw new Error(DEPLOYED_OPTION_MOVED_MESSAGE);

  const local = config.local;
  if (local !== undefined && !isRecord(local)) {
    throw new Error("Self-modification local must be an object.");
  }
  const localEnabled = local?.enabled ?? true;
  if (typeof localEnabled !== "boolean") {
    throw new Error("Self-modification local.enabled must be a boolean.");
  }
  return { localEnabled };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
