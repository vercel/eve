import { defineDynamic } from "#dynamic/definition.js";

import { resolveSelfModificationConfig, type ResolvedSelfModificationConfig } from "../config.js";
import { isLocalSelfModificationEnabled } from "../mode.js";
import selfModification from "./extension.js";

export function resolveLocalOnly<T>(
  config: ResolvedSelfModificationConfig,
  definition: T,
): T | null {
  return isLocalSelfModificationEnabled(config) ? definition : null;
}

export function defineLocalOnlyDynamic<T>(definition: T) {
  return defineDynamic(() =>
    resolveLocalOnly(resolveSelfModificationConfig(selfModification.config), definition),
  );
}
