import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { traceNodeEsmFiles } from "#internal/bundler/nitro-node-file-trace.js";

const COPY_MODE = fsConstants.COPYFILE_FICLONE;

export interface ResolvedAuthoredExternalModule {
  readonly packageName: string;
  readonly resolvedId: string;
}

export async function materializeAuthoredExternalDependencies(input: {
  readonly appRoot: string;
  readonly externalModules: readonly ResolvedAuthoredExternalModule[];
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
}): Promise<string> {
  if (input.externalModules.length === 0) {
    return createHash("sha256").digest("hex");
  }

  const sourceRoot = await realpath(input.sourceRoot);
  const appRoot = await realpath(input.appRoot);
  const packages = await resolveExternalPackages(input.externalModules);

  const fingerprint = createHash("sha256");
  const tracedPaths = await traceExternalDependencyPaths(packages, appRoot);
  const materializedPaths = new Set<string>();
  const materializedDirectories = new Set<string>();

  for (const externalPackage of packages) {
    await materializeDependencyDirectory({
      fingerprint,
      materializedDirectories,
      materializedPaths,
      snapshotSourceRoot: input.snapshotSourceRoot,
      sourcePath: externalPackage.packageRoot,
      sourceRoot,
    });
  }

  for (const tracedPath of tracedPaths) {
    const packageRoot = await findNearestPackageRoot(tracedPath);
    if (packageRoot !== undefined) {
      await materializeDependencyDirectory({
        fingerprint,
        materializedDirectories,
        materializedPaths,
        snapshotSourceRoot: input.snapshotSourceRoot,
        sourcePath: packageRoot,
        sourceRoot,
      });
    }
  }

  for (const tracedPath of tracedPaths) {
    await materializeTracedPath({
      fingerprint,
      materializedPaths,
      snapshotSourceRoot: input.snapshotSourceRoot,
      sourcePath: tracedPath,
      sourceRoot,
    });
  }

  for (const externalPackage of packages) {
    const materializedPackageRoot = toMaterializedPath({
      snapshotSourceRoot: input.snapshotSourceRoot,
      sourcePath: externalPackage.packageRoot,
      sourceRoot,
    });
    const runtimePackageRoot = join(
      toMaterializedPath({
        snapshotSourceRoot: input.snapshotSourceRoot,
        sourcePath: appRoot,
        sourceRoot,
      }),
      "node_modules",
      ...externalPackage.packageName.split("/"),
    );

    if (resolve(runtimePackageRoot) !== resolve(materializedPackageRoot)) {
      await rm(runtimePackageRoot, { force: true, recursive: true });
      await mkdir(dirname(runtimePackageRoot), { recursive: true });
      await symlink(
        relative(dirname(runtimePackageRoot), materializedPackageRoot) || ".",
        runtimePackageRoot,
        "junction",
      );
    }

    fingerprint
      .update("package\0")
      .update(externalPackage.packageName)
      .update("\0")
      .update(toSemanticPath(externalPackage.packageRoot, sourceRoot))
      .update("\0");
  }

  return fingerprint.digest("hex");
}

async function traceExternalDependencyPaths(
  packages: readonly ExternalPackage[],
  processCwd: string,
): Promise<string[]> {
  const groups = new Map<string, { base: string; entries: string[] }>();

  for (const externalPackage of packages) {
    const base = parse(externalPackage.resolvedId).root;
    const key = normalizePathRoot(base);
    const group = groups.get(key) ?? { base, entries: [] };
    group.entries.push(externalPackage.resolvedId);
    groups.set(key, group);
  }

  const tracedPaths = new Set<string>();
  const warnings: Error[] = [];

  for (const group of [...groups.values()].sort((left, right) =>
    normalizePathRoot(left.base).localeCompare(normalizePathRoot(right.base)),
  )) {
    const trace = await traceNodeEsmFiles({
      base: group.base,
      entries: group.entries.sort(),
      processCwd,
    });
    warnings.push(...trace.warnings);

    for (const tracedPath of trace.fileList) {
      tracedPaths.add(isAbsolute(tracedPath) ? tracedPath : resolve(group.base, tracedPath));
    }
  }

  if (warnings.length > 0) {
    const messages = warnings.map((warning) => warning.message).sort();
    throw new Error(
      `Failed to trace the complete authored external dependency closure:\n${messages.join("\n")}`,
    );
  }

  return [...tracedPaths].sort((left, right) => left.localeCompare(right));
}

async function materializeDependencyDirectory(input: {
  readonly fingerprint: ReturnType<typeof createHash>;
  readonly materializedDirectories: Set<string>;
  readonly materializedPaths: Set<string>;
  readonly snapshotSourceRoot: string;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}): Promise<void> {
  const canonicalDirectory = await realpath(input.sourcePath);
  if (input.materializedDirectories.has(canonicalDirectory)) {
    return;
  }
  input.materializedDirectories.add(canonicalDirectory);

  for (const entry of (await readdir(canonicalDirectory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const sourcePath = join(canonicalDirectory, entry.name);
    const sourceStats = await lstat(sourcePath);

    if (sourceStats.isDirectory()) {
      await materializeDependencyDirectory({ ...input, sourcePath });
      continue;
    }

    if (sourceStats.isSymbolicLink()) {
      await materializeTracedPath({
        fingerprint: input.fingerprint,
        materializedPaths: input.materializedPaths,
        snapshotSourceRoot: input.snapshotSourceRoot,
        sourcePath,
        sourceRoot: input.sourceRoot,
      });
      continue;
    }

    await materializeTracedPath({
      fingerprint: input.fingerprint,
      materializedPaths: input.materializedPaths,
      snapshotSourceRoot: input.snapshotSourceRoot,
      sourcePath,
      sourceRoot: input.sourceRoot,
    });
  }
}

interface ExternalPackage {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly resolvedId: string;
}

async function resolveExternalPackages(
  modules: readonly ResolvedAuthoredExternalModule[],
): Promise<ExternalPackage[]> {
  const packagesByName = new Map<string, ExternalPackage>();

  for (const module of modules) {
    const packageRoot = await findPackageRoot(module.resolvedId, module.packageName);
    const existing = packagesByName.get(module.packageName);

    if (existing !== undefined && resolve(existing.packageRoot) !== resolve(packageRoot)) {
      throw new Error(
        `Authored external dependency "${module.packageName}" resolves to multiple package instances.`,
      );
    }

    packagesByName.set(module.packageName, {
      packageName: module.packageName,
      packageRoot,
      resolvedId: module.resolvedId,
    });
  }

  return [...packagesByName.values()].sort((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

async function findPackageRoot(resolvedId: string, packageName: string): Promise<string> {
  let current = dirname(await realpath(resolvedId));

  while (true) {
    const packageJsonPath = join(current, "package.json");

    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        readonly name?: unknown;
      };

      if (packageJson.name === packageName) {
        return current;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Cannot find package root for authored external dependency "${packageName}" from "${resolvedId}".`,
      );
    }
    current = parent;
  }
}

async function findNearestPackageRoot(path: string): Promise<string | undefined> {
  const canonicalPath = await realpath(path);
  let current = (await stat(canonicalPath)).isDirectory() ? canonicalPath : dirname(canonicalPath);

  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
        readonly name?: unknown;
      };
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        return current;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function materializeTracedPath(input: {
  readonly fingerprint: ReturnType<typeof createHash>;
  readonly materializedPaths: Set<string>;
  readonly snapshotSourceRoot: string;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}): Promise<void> {
  const materializedPathKey = toSemanticPath(input.sourcePath, input.sourceRoot);
  if (input.materializedPaths.has(materializedPathKey)) {
    return;
  }
  input.materializedPaths.add(materializedPathKey);

  const targetPath = toMaterializedPath(input);
  const sourceStats = await lstat(input.sourcePath);
  const portablePath = toSemanticPath(input.sourcePath, input.sourceRoot);

  if (sourceStats.isSymbolicLink()) {
    const declaredTarget = await readlink(input.sourcePath);
    const resolvedTarget = await realpath(resolve(dirname(input.sourcePath), declaredTarget));
    const targetLinkTarget = toMaterializedPath({
      snapshotSourceRoot: input.snapshotSourceRoot,
      sourcePath: resolvedTarget,
      sourceRoot: input.sourceRoot,
    });
    const targetStats = await stat(input.sourcePath);

    await rm(targetPath, { force: true, recursive: true });
    await mkdir(dirname(targetPath), { recursive: true });
    await symlink(
      relative(dirname(targetPath), targetLinkTarget) || ".",
      targetPath,
      targetStats.isDirectory() ? "junction" : "file",
    );
    input.fingerprint
      .update(portablePath)
      .update("\0link\0")
      .update(toSemanticPath(resolvedTarget, input.sourceRoot))
      .update("\0");
    return;
  }

  if (!sourceStats.isFile()) {
    throw new Error(`Unsupported traced authored dependency path "${input.sourcePath}".`);
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(input.sourcePath, targetPath, COPY_MODE);
  input.fingerprint
    .update(portablePath)
    .update("\0file\0")
    .update(await readFile(input.sourcePath))
    .update("\0");
}

function toMaterializedPath(input: {
  readonly snapshotSourceRoot: string;
  readonly sourcePath: string;
  readonly sourceRoot: string;
}): string {
  if (isPathInsideOrEqual(input.sourcePath, input.sourceRoot)) {
    return join(input.snapshotSourceRoot, relative(input.sourceRoot, input.sourcePath));
  }

  const pathRoot = parse(resolve(input.sourcePath)).root;
  return join(
    input.snapshotSourceRoot,
    ".eve",
    "external-dependencies",
    createPathRootKey(pathRoot),
    relative(pathRoot, input.sourcePath),
  );
}

function toSemanticPath(path: string, sourceRoot: string): string {
  if (isPathInsideOrEqual(path, sourceRoot)) {
    return `source/${toPortablePath(relative(sourceRoot, path))}`;
  }

  const pathRoot = parse(resolve(path)).root;
  return `external/${createPathRootKey(pathRoot)}/${toPortablePath(relative(pathRoot, path))}`;
}

function createPathRootKey(pathRoot: string): string {
  return createHash("sha256").update(normalizePathRoot(pathRoot)).digest("hex").slice(0, 12);
}

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return !(
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  );
}

function normalizePathRoot(pathRoot: string): string {
  return toPortablePath(pathRoot).toLowerCase();
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}
