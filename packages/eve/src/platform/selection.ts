import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { isPlatformDeclaration, type PlatformDeclaration } from "#platform/declaration.js";
import type { BuildContribution } from "#execution/durable.js";
import type { Build } from "#platform/entities.js";
import { vercelBuild } from "#platform/vercel/build.js";

const BUILT_IN_PLATFORM_MODULE = "src/platform/vercel/declaration.ts";

export function authoredPlatformModule(appRoot: string): string {
  return join(resolve(appRoot), authoredPlatformPath(appRoot));
}

export function authoredPlatformPath(appRoot: string): string {
  const nested = statSync(join(resolve(appRoot), "agent"), { throwIfNoEntry: false });
  return nested?.isDirectory() === true ? "agent/platform.ts" : "platform.ts";
}

export function selectPlatformModule(appRoot: string, platformModule?: string): string {
  if (platformModule !== undefined)
    return isAbsolute(platformModule) ? platformModule : resolve(appRoot, platformModule);
  const authored = authoredPlatformModule(appRoot);
  return existsSync(authored) ? authored : resolvePackageSourceFilePath(BUILT_IN_PLATFORM_MODULE);
}

export async function loadPlatformDeclaration(
  modulePath: string,
  appRoot?: string,
): Promise<PlatformDeclaration<unknown>> {
  const authored = appRoot !== undefined && modulePath === authoredPlatformModule(appRoot);
  const loaded = authored
    ? await loadAuthoredModuleNamespace(modulePath, { appRoot })
    : ((await import(pathToFileURL(modulePath).href)) as Record<string, unknown>);
  if (!isPlatformDeclaration(loaded.default)) {
    const shown = authored ? authoredPlatformPath(appRoot) : modulePath;
    throw new Error(
      `The default export of "${shown}" is not a platform declaration. Export the result of definePlatform({ deployment, ... }) from "eve/experimental/platform" as its default export, or delete the file to use eve's built-in platform.`,
    );
  }
  return loaded.default;
}

export async function loadPlatformBuild(appRoot: string): Promise<Build> {
  return (await loadPlatformDeclaration(selectPlatformModule(appRoot), appRoot)).build ?? {};
}

export async function loadPlatformEngineBuild(
  appRoot: string,
): Promise<BuildContribution | undefined> {
  return (await loadPlatformDeclaration(selectPlatformModule(appRoot), appRoot)).durable?.().build;
}

export function builtInPlatformBuild(): Build {
  return vercelBuild;
}
