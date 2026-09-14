import { dirname, join, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function packageDeclaresEve(
  packageJsonPath: string,
  source: ProjectSource,
): Promise<boolean> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await source.readTextFile(packageJsonPath));
  } catch (error) {
    throw new Error(`The package.json at ${packageJsonPath} is not valid JSON.`, { cause: error });
  }

  if (!isJsonObject(packageJson)) return false;
  const dependencies = packageJson.dependencies;
  return isJsonObject(dependencies) && typeof dependencies.eve === "string";
}

export async function isEveProjectRoot(
  root: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<boolean> {
  const source = options.source ?? createDiskProjectSource();
  const packageJsonPath = join(resolve(root), "package.json");
  if ((await source.stat(packageJsonPath)) !== "file") return false;
  return packageDeclaresEve(packageJsonPath, source);
}

/** Find the nearest package boundary and return it only when it owns an eve project. */
export async function findEveProjectRoot(
  startPath: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<string | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const resolvedStartPath = resolve(startPath);
  let currentDirectory =
    (await source.stat(resolvedStartPath)) === "directory"
      ? resolvedStartPath
      : dirname(resolvedStartPath);

  while (true) {
    const packageJsonPath = join(currentDirectory, "package.json");
    if ((await source.stat(packageJsonPath)) === "file") {
      return (await packageDeclaresEve(packageJsonPath, source)) ? currentDirectory : undefined;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return undefined;
    currentDirectory = parentDirectory;
  }
}
