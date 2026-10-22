import { resolve } from "node:path";

import { importOptionalEnginePackage } from "#internal/application/optional-package-import.js";
import type { SandboxProviderHost } from "#shared/sandbox-provider.js";

export function createSandboxProviderHost(appRoot: string): SandboxProviderHost {
  return {
    // Unused, but the extension contracts include this type; it goes with the legacy provider shape.
    async loadOptionalPackage(input) {
      return await importOptionalEnginePackage({ appRoot, ...input });
    },
    resolveProjectPath(path) {
      return resolve(appRoot, path);
    },
  };
}
