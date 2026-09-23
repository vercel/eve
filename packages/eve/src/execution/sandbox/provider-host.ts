import { resolve } from "node:path";

import { loadOptionalEnginePackage } from "#internal/application/optional-package-install.js";
import type { SandboxProviderHost } from "#shared/sandbox-provider.js";

export function createSandboxProviderHost(input: {
  readonly allowInstall: boolean;
  readonly appRoot: string;
}): SandboxProviderHost {
  return {
    async loadOptionalPackage(request) {
      return await loadOptionalEnginePackage({
        ...request,
        appRoot: input.appRoot,
        autoInstall: input.allowInstall && request.autoInstall,
      });
    },
    resolveProjectPath(path) {
      return resolve(input.appRoot, path);
    },
  };
}
