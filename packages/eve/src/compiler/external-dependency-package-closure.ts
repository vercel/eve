import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type {
  CompiledExternalDependencyPlanEntry,
  CompiledExternalDependencyScope,
} from "#compiler/external-dependency-plan-schema.js";
import { EXTERNAL_DEPENDENCY_CONDITIONS } from "#compiler/external-dependency-plan-schema.js";

const IGNORED_PACKAGE_DIRECTORIES = new Set([".git", ".hg", ".svn", ".turbo", "node_modules"]);

interface MutablePackageRecord {
  readonly contentSha256: string;
  readonly dependencies: Array<{ packageId: string; packageName: string }>;
  readonly id: string;
  readonly packageName: string;
  readonly resolvedPackageRoot: string;
}

export async function createExternalDependencyPlanEntry(input: {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly scopes: readonly CompiledExternalDependencyScope[];
}): Promise<CompiledExternalDependencyPlanEntry> {
  const { packageName, packageRoot } = input;
  const packages: MutablePackageRecord[] = [];
  const packageIdsByRoot = new Map<string, string>();

  const visitPackage = async (root: string, expectedName: string): Promise<string> => {
    const canonicalRoot = realpathSync.native(root);
    const existingId = packageIdsByRoot.get(canonicalRoot);
    if (existingId !== undefined) return existingId;
    const manifest = readPackageJson(canonicalRoot);
    const actualName = typeof manifest.name === "string" ? manifest.name : expectedName;
    const id = String(packages.length);
    packageIdsByRoot.set(canonicalRoot, id);
    const record: MutablePackageRecord = {
      contentSha256: await createPackageContentHash(canonicalRoot),
      dependencies: [],
      id,
      packageName: actualName,
      resolvedPackageRoot: canonicalRoot,
    };
    packages.push(record);
    const dependencies = collectPackageDependencies(manifest);
    for (const dependency of dependencies) {
      if (isBuiltin(dependency.packageName)) continue;
      let dependencyRoot: string;
      try {
        dependencyRoot = resolveInstalledPackageRoot(dependency.packageName, canonicalRoot);
      } catch (error) {
        if (dependency.optional) continue;
        throw new Error(
          `Cannot resolve ${dependency.peer ? "peer " : ""}dependency "${dependency.packageName}" required by "${actualName}" while compiling external dependency "${packageName}".`,
          { cause: error },
        );
      }
      const packageId = await visitPackage(dependencyRoot, dependency.packageName);
      record.dependencies.push({ packageId, packageName: dependency.packageName });
    }
    record.dependencies.sort((left, right) => compareStrings(left.packageName, right.packageName));
    return id;
  };

  const rootPackageId = await visitPackage(packageRoot, packageName);
  const withoutDigest = {
    conditions: [...EXTERNAL_DEPENDENCY_CONDITIONS] as ["node", "import", "default"],
    id: packageName,
    packageName,
    packages,
    rootPackageId,
    scopes: canonicalExternalDependencyScopes(input.scopes),
  };
  return {
    ...withoutDigest,
    semanticSha256: createCompiledExternalDependencySemanticHash(withoutDigest),
  };
}

export function findResolvedPackageRoot(packageName: string, resolvedPackagePath: string): string {
  let directory = dirname(resolvedPackagePath);
  while (true) {
    if (isInstalledPackageRoot(directory) && existsSync(join(directory, "package.json"))) {
      return realpathSync.native(directory);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Cannot locate package root for external dependency "${packageName}" resolved as "${resolvedPackagePath}".`,
  );
}

export function resolveInstalledPackageRoot(packageName: string, resolutionRoot: string): string {
  const require = createRequire(join(resolve(resolutionRoot), "package.json"));
  const packageJsonPath = require.resolve
    .paths(packageName)
    ?.map((searchRoot) => join(searchRoot, ...packageName.split("/"), "package.json"))
    .find(existsSync);
  if (packageJsonPath !== undefined) {
    return realpathSync.native(dirname(packageJsonPath));
  }

  let entryPath: string;
  try {
    entryPath = require.resolve(packageName);
  } catch (error) {
    throw new Error(
      `Cannot resolve external dependency "${packageName}" from "${resolutionRoot}".`,
      { cause: error },
    );
  }
  let directory = dirname(realpathSync.native(entryPath));
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readPackageJson(directory);
      if (manifest.name === packageName) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Cannot locate package root for external dependency "${packageName}" resolved from "${resolutionRoot}".`,
  );
}

/** Hashes one package's own bytes; installed dependency directories are separate plan nodes. */
export async function createPackageContentHash(packageRoot: string): Promise<string> {
  const root = await realpath(packageRoot);
  const records: Array<{ mode: number; path: string; sha256: string }> = [];
  await collectPackageFileRecords(root, root, records);
  records.sort((left, right) => compareStrings(left.path, right.path));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

/** Used by immutable package materialization to exclude separately planned dependency trees. */
export function shouldCopyExternalDependencyPackagePath(
  sourcePath: string,
  packageRoot: string,
): boolean {
  const relativePath = normalizeRelativePath(relative(packageRoot, sourcePath));
  if (relativePath === "") return true;
  return !relativePath.split("/").some((part) => IGNORED_PACKAGE_DIRECTORIES.has(part));
}

export function createCompiledExternalDependencySemanticHash(
  entry:
    | Omit<CompiledExternalDependencyPlanEntry, "semanticSha256">
    | CompiledExternalDependencyPlanEntry,
): string {
  const rootPackage = entry.packages.find((pkg) => pkg.id === entry.rootPackageId);
  if (rootPackage === undefined) {
    throw new Error(`Cannot identify external dependency "${entry.id}" without its root package.`);
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        conditions: entry.conditions,
        packageName: entry.packageName,
        packages: entry.packages.map((pkg) => ({
          contentSha256: pkg.contentSha256,
          dependencies: pkg.dependencies,
          id: pkg.id,
          packageName: pkg.packageName,
        })),
        rootPackageId: entry.rootPackageId,
      }),
    )
    .digest("hex");
}

export function canonicalExternalDependencyScopes(
  scopes: readonly CompiledExternalDependencyScope[],
): CompiledExternalDependencyScope[] {
  const byKey = new Map(
    scopes.map((scope) => [externalDependencyScopeSortKey(scope), { ...scope }]),
  );
  return [...byKey.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, scope]) => scope);
}

export function externalDependencyScopeSortKey(scope: CompiledExternalDependencyScope): string {
  return scope.kind === "application"
    ? `application\0${scope.nodeId}\0${scope.sourceRoot}`
    : `extension\0${scope.nodeId}\0${scope.namespace}\0${scope.packageName}\0${scope.sourceRoot}`;
}

export function compareExternalDependencyStrings(left: string, right: string): number {
  return compareStrings(left, right);
}

function isInstalledPackageRoot(directory: string): boolean {
  const parent = dirname(directory);
  if (basename(parent) === "node_modules") return true;
  return basename(dirname(parent)) === "node_modules" && basename(parent).startsWith("@");
}

function collectPackageDependencies(manifest: Record<string, unknown>): Array<{
  optional: boolean;
  packageName: string;
  peer: boolean;
}> {
  const dependencies = new Map<string, { optional: boolean; packageName: string; peer: boolean }>();
  for (const packageName of objectKeys(manifest.dependencies)) {
    dependencies.set(packageName, { optional: false, packageName, peer: false });
  }
  for (const packageName of objectKeys(manifest.optionalDependencies)) {
    dependencies.set(packageName, { optional: true, packageName, peer: false });
  }
  const peerMetadata = isObjectRecord(manifest.peerDependenciesMeta)
    ? manifest.peerDependenciesMeta
    : {};
  for (const packageName of objectKeys(manifest.peerDependencies)) {
    const metadata = peerMetadata[packageName];
    dependencies.set(packageName, {
      optional: isObjectRecord(metadata) && metadata.optional === true,
      packageName,
      peer: true,
    });
  }
  return [...dependencies.values()].sort((left, right) =>
    compareStrings(left.packageName, right.packageName),
  );
}

async function collectPackageFileRecords(
  root: string,
  directory: string,
  records: Array<{ mode: number; path: string; sha256: string }>,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_PACKAGE_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`External dependency package contains unsupported symlink "${path}".`);
    }
    if (stats.isDirectory()) {
      await collectPackageFileRecords(root, path, records);
      continue;
    }
    if (!stats.isFile()) continue;
    const bytes = await readFile(path);
    records.push({
      mode: stats.mode & 0o777,
      path: normalizeRelativePath(relative(root, path)),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

function readPackageJson(packageRoot: string): Record<string, unknown> {
  const packageJsonPath = join(packageRoot, "package.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read external dependency package manifest "${packageJsonPath}".`, {
      cause: error,
    });
  }
  if (!isObjectRecord(value)) {
    throw new Error(`External dependency package manifest "${packageJsonPath}" is not an object.`);
  }
  return value;
}

function objectKeys(value: unknown): string[] {
  return isObjectRecord(value) ? Object.keys(value).sort(compareStrings) : [];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export function assertExternalDependencyPackageName(packageName: string): void {
  if (
    packageName.length === 0 ||
    packageName.startsWith(".") ||
    packageName.startsWith("/") ||
    packageName.includes("\\") ||
    packageName.split("/").some((part) => part === "" || part === "." || part === "..") ||
    (packageName.startsWith("@") ? packageName.split("/").length !== 2 : packageName.includes("/"))
  ) {
    throw new Error(`Invalid external dependency package name "${packageName}".`);
  }
}
