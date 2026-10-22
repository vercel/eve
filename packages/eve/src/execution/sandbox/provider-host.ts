import { resolve } from "node:path";

import { importInstalledEnginePackage } from "#internal/application/optional-package-import.js";
import type { SandboxProviderHost } from "#shared/sandbox-provider.js";

export function createSandboxProviderHost(appRoot: string): SandboxProviderHost {
  return {
    async loadOptionalPackage(input) {
      return await importOptionalEnginePackage({ appRoot, ...input });
    },
    resolveProjectPath(path) {
      return resolve(appRoot, path);
    },
  };
}

/**
 * Loads an optional engine without installing it: from eve's own resolution
 * first, then from the application. Fails with `missingMessage`.
 */
export async function importOptionalEnginePackage<T>(input: {
  readonly appRoot: string;
  readonly importModule: () => Promise<T>;
  readonly missingMessage: string;
  readonly packageName: string;
}): Promise<T> {
  try {
    return await input.importModule();
  } catch (importError) {
    try {
      return await importInstalledEnginePackage<T>({
        appRoot: input.appRoot,
        packageName: input.packageName,
      });
    } catch (installedImportError) {
      throw new Error(input.missingMessage, {
        cause: new AggregateError([importError, installedImportError]),
      });
    }
  }
}
