import { resolve } from "node:path";

import type { SandboxProviderHost } from "#shared/sandbox-provider.js";

export function createSandboxProviderHost(appRoot: string): SandboxProviderHost {
  return {
    async loadOptionalPackage(input) {
      try {
        return await input.importModule();
      } catch (error) {
        throw new Error(input.missingMessage, { cause: error });
      }
    },
    resolveProjectPath(path) {
      return resolve(appRoot, path);
    },
  };
}
