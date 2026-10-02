import { resolve } from "node:path";

import { importInstalledEnginePackage } from "#internal/application/optional-package-import.js";
import type { SandboxProviderHost } from "#shared/sandbox-provider.js";

export function createSandboxProviderHost(appRoot: string): SandboxProviderHost {
  return {
    async loadOptionalPackage(input) {
      try {
        return await input.importModule();
      } catch (importError) {
        try {
          return await importInstalledEnginePackage({
            appRoot,
            packageName: input.packageName,
          });
        } catch (installedImportError) {
          throw new Error(input.missingMessage, {
            cause: new AggregateError([importError, installedImportError]),
          });
        }
      }
    },
    resolveProjectPath(path) {
      return resolve(appRoot, path);
    },
  };
}
