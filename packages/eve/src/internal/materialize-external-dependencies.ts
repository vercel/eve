import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { CompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import {
  assertCompiledExternalDependencyPlanSemantics,
  createPackageContentHash,
  shouldCopyExternalDependencyPackagePath,
  verifyCompiledExternalDependencyPlanFiles,
} from "#compiler/external-dependency-plan.js";

export interface MaterializedExternalDependencyPlan {
  readonly entryPackageRoots: ReadonlyMap<string, string>;
  readonly plan: CompiledExternalDependencyPlan;
}

export const EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT = "v2";

const inFlightMaterializations = new Map<string, Promise<MaterializedExternalDependencyPlan>>();

/** Copies one authenticated package plan into content-addressed immutable storage. */
export async function materializeCompiledExternalDependencyPlan(input: {
  readonly destinationRoot: string;
  readonly plan: CompiledExternalDependencyPlan;
}): Promise<MaterializedExternalDependencyPlan> {
  await verifyCompiledExternalDependencyPlanFiles(input.plan);
  const destinationRoot = join(input.destinationRoot, EXTERNAL_DEPENDENCY_MATERIALIZATION_LAYOUT);
  const key = `${destinationRoot}\0${input.plan.entries
    .map((entry) => entry.semanticSha256)
    .join("\0")}`;
  const existing = inFlightMaterializations.get(key);
  if (existing !== undefined) return await existing;
  const materialization = doMaterializeCompiledExternalDependencyPlan({
    destinationRoot,
    plan: input.plan,
  }).finally(() => {
    inFlightMaterializations.delete(key);
  });
  inFlightMaterializations.set(key, materialization);
  return await materialization;
}

async function doMaterializeCompiledExternalDependencyPlan(input: {
  readonly destinationRoot: string;
  readonly plan: CompiledExternalDependencyPlan;
}): Promise<MaterializedExternalDependencyPlan> {
  const entryPackageRoots = new Map<string, string>();
  for (const entry of input.plan.entries) {
    const finalEntryRoot = join(input.destinationRoot, entry.semanticSha256);
    if (await pathExists(finalEntryRoot)) {
      await assertCompleteEntry(finalEntryRoot, entry);
    } else {
      const temporaryEntryRoot = `${finalEntryRoot}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(finalEntryRoot), { recursive: true });
        await mkdir(temporaryEntryRoot, { recursive: false });
        for (const pkg of entry.packages) {
          const targetRoot = join(temporaryEntryRoot, pkg.id);
          await mkdir(dirname(targetRoot), { recursive: true });
          await cp(pkg.resolvedPackageRoot, targetRoot, {
            filter: (sourcePath) =>
              shouldCopyExternalDependencyPackagePath(sourcePath, pkg.resolvedPackageRoot),
            recursive: true,
          });
          const copiedHash = await createPackageContentHash(targetRoot);
          if (copiedHash !== pkg.contentSha256) {
            throw new Error(
              `External dependency "${entry.id}" package "${pkg.packageName}" changed while materializing its immutable copy.`,
            );
          }
        }

        const temporaryRoots = packageRootsById(entry, temporaryEntryRoot);
        const finalRoots = packageRootsById(entry, finalEntryRoot);
        await linkMaterializedPackageDependencies(entry, temporaryRoots, finalRoots);
        try {
          await rename(temporaryEntryRoot, finalEntryRoot);
        } catch (publishError) {
          if (!(await pathExists(finalEntryRoot))) throw publishError;
          try {
            await assertCompleteEntry(finalEntryRoot, entry);
          } catch (validationError) {
            throw new Error(
              `External dependency "${entry.id}" could not publish because its immutable cache entry is invalid.`,
              { cause: validationError },
            );
          }
        }
      } finally {
        await rm(temporaryEntryRoot, { force: true, recursive: true });
      }
      await assertCompleteEntry(finalEntryRoot, entry);
    }
    entryPackageRoots.set(entry.id, join(finalEntryRoot, entry.rootPackageId));
  }
  const plan = relocateCompiledExternalDependencyPlan(input.plan, input.destinationRoot);
  return { entryPackageRoots, plan };
}

function relocateCompiledExternalDependencyPlan(
  plan: CompiledExternalDependencyPlan,
  destinationRoot: string,
): CompiledExternalDependencyPlan {
  const relocated = {
    entries: plan.entries.map((entry) => {
      const entryRoot = join(destinationRoot, entry.semanticSha256);
      return {
        ...entry,
        packages: entry.packages.map((pkg) => ({
          ...pkg,
          resolvedPackageRoot: join(entryRoot, pkg.id),
        })),
      };
    }),
  };
  assertCompiledExternalDependencyPlanSemantics(relocated);
  return relocated;
}

async function linkMaterializedPackageDependencies(
  entry: CompiledExternalDependencyPlan["entries"][number],
  mountRootsByPackageId: ReadonlyMap<string, string>,
  targetRootsByPackageId: ReadonlyMap<string, string>,
): Promise<void> {
  for (const pkg of entry.packages) {
    const packageRoot = mountRootsByPackageId.get(pkg.id)!;
    for (const [packageName, targetPackageId] of packageLinkTargets(pkg)) {
      const dependencyRoot = targetRootsByPackageId.get(targetPackageId);
      if (dependencyRoot === undefined) {
        throw new Error(
          `External dependency "${entry.id}" package "${pkg.id}" references missing materialized package "${targetPackageId}".`,
        );
      }
      const dependencyMount = join(packageRoot, "node_modules", ...packageName.split("/"));
      await mkdir(dirname(dependencyMount), { recursive: true });
      await symlink(resolve(dependencyRoot), dependencyMount, "junction");
    }
  }
}

async function assertCompleteEntry(
  entryRoot: string,
  entry: CompiledExternalDependencyPlan["entries"][number],
): Promise<void> {
  for (const pkg of entry.packages) {
    const packageRoot = join(entryRoot, pkg.id);
    if (!(await pathExists(packageRoot))) {
      throw invalidCacheEntryError(entry.id, `package "${pkg.id}" is missing`);
    }
    if ((await createPackageContentHash(packageRoot)) !== pkg.contentSha256) {
      throw invalidCacheEntryError(entry.id, `package "${pkg.id}" has changed`);
    }
  }
  await assertMaterializedPackageDependencyLinks(entry, packageRootsById(entry, entryRoot));
}

async function assertMaterializedPackageDependencyLinks(
  entry: CompiledExternalDependencyPlan["entries"][number],
  rootsByPackageId: ReadonlyMap<string, string>,
): Promise<void> {
  for (const pkg of entry.packages) {
    const packageRoot = rootsByPackageId.get(pkg.id)!;
    const nodeModulesRoot = join(packageRoot, "node_modules");
    const expectedUnscoped = new Map<string, string>();
    const expectedScoped = new Map<string, Map<string, string>>();
    for (const [packageName, targetPackageId] of packageLinkTargets(pkg)) {
      const dependencyRoot = rootsByPackageId.get(targetPackageId);
      if (dependencyRoot === undefined) {
        throw invalidCacheEntryError(
          entry.id,
          `package "${pkg.id}" references missing package "${targetPackageId}"`,
        );
      }
      const parts = packageName.split("/");
      if (parts.length === 1) {
        expectedUnscoped.set(parts[0]!, dependencyRoot);
        continue;
      }
      const scope = parts[0]!;
      const name = parts[1]!;
      const scoped = expectedScoped.get(scope) ?? new Map<string, string>();
      scoped.set(name, dependencyRoot);
      expectedScoped.set(scope, scoped);
    }

    const expectedRootEntries = [...expectedUnscoped.keys(), ...expectedScoped.keys()].sort();
    const actualRootEntries = await readDirectoryNames(nodeModulesRoot);
    assertExactDirectoryEntries({
      actual: actualRootEntries,
      entryId: entry.id,
      expected: expectedRootEntries,
      path: nodeModulesRoot,
    });

    for (const [name, dependencyRoot] of expectedUnscoped) {
      await assertDependencyLink({
        dependencyMount: join(nodeModulesRoot, name),
        dependencyRoot,
        entryId: entry.id,
      });
    }
    for (const [scope, dependencies] of expectedScoped) {
      const scopeRoot = join(nodeModulesRoot, scope);
      const scopeStats = await lstat(scopeRoot);
      if (!scopeStats.isDirectory() || scopeStats.isSymbolicLink()) {
        throw invalidCacheEntryError(entry.id, `dependency scope "${scope}" is not a directory`);
      }
      assertExactDirectoryEntries({
        actual: await readDirectoryNames(scopeRoot),
        entryId: entry.id,
        expected: [...dependencies.keys()].sort(),
        path: scopeRoot,
      });
      for (const [name, dependencyRoot] of dependencies) {
        await assertDependencyLink({
          dependencyMount: join(scopeRoot, name),
          dependencyRoot,
          entryId: entry.id,
        });
      }
    }
  }
}

function packageLinkTargets(
  pkg: CompiledExternalDependencyPlan["entries"][number]["packages"][number],
): ReadonlyMap<string, string> {
  return new Map([
    ...pkg.dependencies.map(
      (dependency) => [dependency.packageName, dependency.packageId] as const,
    ),
    [pkg.packageName, pkg.id] as const,
  ]);
}

async function assertDependencyLink(input: {
  readonly dependencyMount: string;
  readonly dependencyRoot: string;
  readonly entryId: string;
}): Promise<void> {
  const stats = await lstat(input.dependencyMount);
  if (!stats.isSymbolicLink()) {
    throw invalidCacheEntryError(
      input.entryId,
      `dependency mount "${input.dependencyMount}" is not a symbolic link`,
    );
  }
  const [actualRoot, expectedRoot] = await Promise.all([
    realpath(input.dependencyMount),
    realpath(input.dependencyRoot),
  ]);
  if (actualRoot !== expectedRoot) {
    throw invalidCacheEntryError(
      input.entryId,
      `dependency mount "${input.dependencyMount}" points to an unexpected package`,
    );
  }
}

function assertExactDirectoryEntries(input: {
  readonly actual: readonly string[];
  readonly entryId: string;
  readonly expected: readonly string[];
  readonly path: string;
}): void {
  if (JSON.stringify(input.actual) !== JSON.stringify(input.expected)) {
    throw invalidCacheEntryError(
      input.entryId,
      `dependency directory "${input.path}" does not match the compiled link graph`,
    );
  }
}

async function readDirectoryNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function packageRootsById(
  entry: CompiledExternalDependencyPlan["entries"][number],
  entryRoot: string,
): ReadonlyMap<string, string> {
  return new Map(entry.packages.map((pkg) => [pkg.id, join(entryRoot, pkg.id)] as const));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function invalidCacheEntryError(entryId: string, detail: string): Error {
  return new Error(`External dependency "${entryId}" immutable cache entry is invalid: ${detail}.`);
}
