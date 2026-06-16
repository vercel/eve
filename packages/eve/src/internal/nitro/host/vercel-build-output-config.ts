import { resolveInstalledPackageInfo } from "#internal/application/package.js";

export function createEveVercelOptions(enabled: boolean) {
  if (!enabled) {
    return undefined;
  }

  return {
    config: {
      version: 3 as const,
      framework: {
        version: resolveInstalledPackageInfo().version,
      },
    },
  };
}
