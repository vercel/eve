import { resolve } from "node:path";

import { loadOptionalEnginePackage } from "#internal/application/optional-package-install.js";
import type { SandboxProviderHost } from "#shared/sandbox-provider.js";

export function createDevelopmentSandboxProviderHost(appRoot: string): SandboxProviderHost {
  return {
    async loadOptionalPackage(input) {
      return await loadOptionalEnginePackage({ appRoot, ...input });
    },
    resolveProjectPath(path) {
      return resolve(appRoot, path);
    },
  };
}
