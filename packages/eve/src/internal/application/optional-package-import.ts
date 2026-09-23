import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Imports an optional engine from the application without installing it. */
export async function importInstalledEnginePackage<T>(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): Promise<T> {
  const entrypointHref = await resolveInstalledEnginePackageEntrypointHref(input);
  return (await import(entrypointHref)) as T;
}

export async function resolveInstalledEnginePackageEntrypointHref(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): Promise<string> {
  const packageRoot = findInstalledPackageRoot(input);
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly exports?: unknown;
    readonly main?: unknown;
    readonly module?: unknown;
  };
  const entry = resolvePackageEntryPoint(packageJson);
  if (entry.startsWith("/")) {
    throw new Error(`Invalid absolute entrypoint for optional package "${input.packageName}".`);
  }
  return pathToFileURL(join(packageRoot, entry)).href;
}

function findInstalledPackageRoot(input: {
  readonly appRoot: string;
  readonly packageName: string;
}): string {
  const packagePathSegments = input.packageName.split("/");
  const checkedPaths: string[] = [];
  let current = resolve(input.appRoot);
  try {
    current = realpathSync.native(current);
  } catch {}

  for (;;) {
    const packageRoot = join(current, "node_modules", ...packagePathSegments);
    checkedPaths.push(packageRoot);
    if (existsSync(join(packageRoot, "package.json"))) {
      return packageRoot;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not find installed optional dependency "${input.packageName}". Checked: ${checkedPaths.join(", ")}`,
      );
    }
    current = parent;
  }
}

function resolvePackageEntryPoint(packageJson: {
  readonly exports?: unknown;
  readonly main?: unknown;
  readonly module?: unknown;
}): string {
  const dotExport = readDotExport(packageJson.exports);
  if (dotExport !== undefined) {
    return dotExport;
  }
  if (typeof packageJson.module === "string" && packageJson.module.length > 0) {
    return packageJson.module;
  }
  if (typeof packageJson.main === "string" && packageJson.main.length > 0) {
    return packageJson.main;
  }
  return "index.js";
}

function readDotExport(exportsValue: unknown): string | undefined {
  if (typeof exportsValue === "string" && exportsValue.length > 0) {
    return exportsValue;
  }
  if (typeof exportsValue !== "object" || exportsValue === null) {
    return undefined;
  }

  const dotExport =
    "." in exportsValue ? (exportsValue as { readonly ".": unknown })["."] : exportsValue;
  if (typeof dotExport === "string" && dotExport.length > 0) {
    return dotExport;
  }
  if (typeof dotExport !== "object" || dotExport === null) {
    return undefined;
  }

  const conditional = dotExport as { readonly import?: unknown; readonly default?: unknown };
  if (typeof conditional.import === "string" && conditional.import.length > 0) {
    return conditional.import;
  }
  if (typeof conditional.default === "string" && conditional.default.length > 0) {
    return conditional.default;
  }
  return undefined;
}
