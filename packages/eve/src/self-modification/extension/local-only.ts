import { defineDynamic } from "#dynamic/definition.js";

import { resolveSelfModificationConfig } from "../config.js";
import { isLocalSelfModificationEnabled } from "../mode.js";
import selfModification from "./extension.js";

export function defineLocalOnlyDynamic<T>(definition: T) {
  return defineDynamic(() =>
    isLocalSelfModificationEnabled(resolveSelfModificationConfig(selfModification.config))
      ? definition
      : null,
  );
}
