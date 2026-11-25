import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { isPlatformDeclaration, type PlatformDeclaration } from "#platform/declaration.js";
import type { Build } from "#platform/entities.js";
import { vercelBuild } from "#platform/vercel/build.js";

const BUILT_IN_PLATFORM_MODULE = "src/platform/vercel/declaration.ts";

export function selectPlatformModule(appRoot: string, platformModule?: string): string {
  if (platformModule === undefined) return resolvePackageSourceFilePath(BUILT_IN_PLATFORM_MODULE);
  return isAbsolute(platformModule) ? platformModule : resolve(appRoot, platformModule);
}

export async function loadPlatformDeclaration(
  modulePath: string,
): Promise<PlatformDeclaration<unknown>> {
  const loaded = (await import(pathToFileURL(modulePath).href)) as { readonly default?: unknown };
  if (!isPlatformDeclaration(loaded.default)) {
    throw new Error(
      `The default export of "${modulePath}" is not a platform declaration. Export the result of definePlatform({ deployment, ... }) as the module's default export.`,
    );
  }
  return loaded.default;
}

export async function loadPlatformBuild(appRoot: string): Promise<Build> {
  return (await loadPlatformDeclaration(selectPlatformModule(appRoot))).build ?? {};
}

export function builtInPlatformBuild(): Build {
  return vercelBuild;
}
