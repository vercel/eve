import { defineDynamic } from "#dynamic/definition.js";

import { resolveSelfModificationConfig, type ResolvedSelfModificationConfig } from "../config.js";
import { isLocalSelfModificationEnabled } from "../mode.js";
import selfModification from "./extension.js";

/** Returns a definition only when self-modification is running locally. */
export function resolveLocalOnly<T>(
  config: ResolvedSelfModificationConfig,
  definition: T,
): T | null {
  return isLocalSelfModificationEnabled(config) ? definition : null;
}

/** Creates a dynamic definition that is present only during local development. */
export function defineLocalOnlyDynamic<T>(definition: T) {
  return defineDynamic({
    select: () => null,
    resolve: () =>
      resolveLocalOnly(resolveSelfModificationConfig(selfModification.config), definition),
  });
}
