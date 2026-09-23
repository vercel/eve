import { resolve } from "node:path";

import { importInstalledEnginePackage } from "#internal/application/optional-package-import.js";
import type { SandboxProviderHost } from "#shared/sandbox-provider.js";

export function createSandboxProviderHost(input: {
  readonly appRoot: string;
  readonly loadOptionalPackage?: typeof import("#internal/application/optional-package-install.js").loadOptionalEnginePackage;
}): SandboxProviderHost {
  return {
    async loadOptionalPackage(request) {
      if (input.loadOptionalPackage !== undefined) {
        return await input.loadOptionalPackage({ ...request, appRoot: input.appRoot });
      }
      try {
        return await request.importModule();
      } catch (importError) {
        try {
          return await importInstalledEnginePackage({
            appRoot: input.appRoot,
            packageName: request.packageName,
          });
        } catch (installedImportError) {
          throw new Error(request.missingMessage, {
            cause: new AggregateError([importError, installedImportError]),
          });
        }
      }
    },
    resolveProjectPath(path) {
      return resolve(input.appRoot, path);
    },
  };
}
