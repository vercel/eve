import { defineDynamic } from "#dynamic/definition.js";

import { resolveSelfModificationConfig, type ResolvedSelfModificationConfig } from "../config.js";
import { resolveSelfModificationMode } from "../mode.js";
import selfModification from "./extension.js";

/** Returns a definition only when self-modification is running locally. */
export function resolveLocalOnly<T>(
  config: ResolvedSelfModificationConfig,
  definition: T,
): T | null {
  return resolveSelfModificationMode(config) === "local" ? definition : null;
}

/** Creates a dynamic definition that is absent from deployed self-modification. */
export function defineLocalOnlyDynamic<T>(definition: T) {
  return defineDynamic({
    events: {
      "session.started": () =>
        resolveLocalOnly(resolveSelfModificationConfig(selfModification.config), definition),
    },
  });
}
