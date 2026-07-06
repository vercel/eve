import { constants as fsConstants, existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  extractTsConfigExtendsSpecifiers,
  isTsConfigFilePath,
  parseTsConfigObject,
  readTextFileIfExists,
  resolveFirstExistingTsConfigExtendsTarget,
  resolveTsConfigExtendsTargetPaths,
} from "#internal/application/tsconfig-dependencies.js";
import {
  DevelopmentRuntimeSourceSnapshotError,
  type DevelopmentSourceSnapshotPlan,
  toDevelopmentSourceSnapshotPath,
} from "#internal/nitro/dev-runtime-source-snapshot.js";

const SNAPSHOT_SKIP_NAMES = new Set([
  ".generated",
  ".eve",
  ".git",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  ".workflow-data",
  "node_modules",
]);
const SNAPSHOT_APP_ROOT_SKIP_NAMES = new Set(["build", "dist"]);
const SNAPSHOT_COPY_MODE = fsConstants.COPYFILE_FICLONE;

export async function copyDevelopmentSourceSnapshot(
  plan: DevelopmentSourceSnapshotPlan,
): Promise<void> {
  await mkdir(plan.snapshotSourceRoot, { recursive: true });

  for (const sourceRoot of plan.copyRoots) {
    await copySnapshotPath({
      plan,
      sourcePath: sourceRoot,
      targetPath: toSnapshotPathForPlan(plan, sourceRoot),
    });
  }

  for (const sourcePath of plan.copyFiles) {
    if (!existsSync(sourcePath)) {
      continue;
    }

    await copySnapshotPath({
      plan,
      sourcePath,
      targetPath: toSnapshotPathForPlan(plan, sourcePath),
    });
  }

  await rewriteSnapshotTsConfigAbsoluteExtends(plan);
  await createSnapshotSymlinks(plan);
  await ensureRuntimePackageJson(plan);
  await validateDevelopmentSourceSnapshot(plan);
}

async function copySnapshotPath(input: {
  readonly plan: DevelopmentSourceSnapshotPlan;
  readonly sourcePath: string;
  readonly targetPath: string;
}): Promise<void> {
  try {
    const stats = await lstat(input.sourcePath);

    if (stats.isDirectory()) {
      await copySnapshotDirectory(input);
      return;
    }

    await mkdir(dirname(input.targetPath), { recursive: true });
    await cp(input.sourcePath, input.targetPath, {
      mode: SNAPSHOT_COPY_MODE,
      recursive: true,
    });
  } catch (error) {
    throw new DevelopmentRuntimeSourceSnapshotError(
      `Failed to copy development runtime source snapshot path "${input.sourcePath}" to "${input.targetPath}": ${formatErrorMessage(error)}`,
    );
  }
}

async function copySnapshotDirectory(input: {
  readonly plan: DevelopmentSourceSnapshotPlan;
  readonly sourcePath: string;
  readonly targetPath: string;
}): Promise<void> {
  await mkdir(input.targetPath, { recursive: true });

  for (const entry of await readdir(input.sourcePath, { withFileTypes: true })) {
    const sourcePath = join(input.sourcePath, entry.name);

    if (shouldSkipSnapshotSource(input.plan, sourcePath)) {
      continue;
    }

    await cp(sourcePath, join(input.targetPath, entry.name), {
      filter: (source) => !shouldSkipSnapshotSource(input.plan, source),
      mode: SNAPSHOT_COPY_MODE,
      recursive: true,
    });
  }
}

function shouldSkipSnapshotSource(
  plan: DevelopmentSourceSnapshotPlan,
  sourcePath: string,
): boolean {
  const relativePath = relative(plan.sourceRoot, sourcePath);
  if (relativePath.length === 0) {
    return false;
  }

  if (
    relativePath
      .split(/[\\/]/)
      .some((part) => SNAPSHOT_SKIP_NAMES.has(part) || part.startsWith(".env"))
  ) {
    return true;
  }

  return isDirectAppRootSkipPath({
    appRoot: plan.appRoot,
    sourcePath,
  });
}

function isDirectAppRootSkipPath(input: {
  readonly appRoot: string;
  readonly sourcePath: string;
}): boolean {
  if (!isPathInsideOrEqual(input.sourcePath, input.appRoot)) {
    return false;
  }

  const relativePath = relative(input.appRoot, input.sourcePath);
  if (relativePath.length === 0) {
    return false;
  }

  const firstPart = relativePath.split(/[\\/]/)[0];
  return firstPart !== undefined && SNAPSHOT_APP_ROOT_SKIP_NAMES.has(firstPart);
}

async function rewriteSnapshotTsConfigAbsoluteExtends(
  plan: DevelopmentSourceSnapshotPlan,
): Promise<void> {
  for (const configPath of plan.tsconfigPaths) {
    const source = await readTextFileIfExists(configPath);

    if (source === undefined) {
      continue;
    }

    const rewritten = rewriteTsConfigAbsoluteExtends({
      configPath,
      snapshotConfigPath: toSnapshotPathForPlan(plan, configPath),
      snapshotSourceRoot: plan.snapshotSourceRoot,
      source,
      sourceRoot: plan.sourceRoot,
    });

    if (rewritten === undefined) {
      continue;
    }

    await writeFile(toSnapshotPathForPlan(plan, configPath), rewritten);
  }
}

function rewriteTsConfigAbsoluteExtends(input: {
  readonly configPath: string;
  readonly snapshotConfigPath: string;
  readonly snapshotSourceRoot: string;
  readonly source: string;
  readonly sourceRoot: string;
}): string | undefined {
  const parsedConfig = parseTsConfigObject(input.source);

  if (parsedConfig === undefined) {
    return undefined;
  }

  const rewrittenExtends = rewriteTsConfigExtendsValue({
    configPath: input.configPath,
    snapshotConfigPath: input.snapshotConfigPath,
    snapshotSourceRoot: input.snapshotSourceRoot,
    sourceRoot: input.sourceRoot,
    value: parsedConfig.extends,
  });

  if (rewrittenExtends.changed !== true) {
    return undefined;
  }

  return `${JSON.stringify(
    {
      ...parsedConfig,
      extends: rewrittenExtends.value,
    },
    null,
    2,
  )}\n`;
}

function rewriteTsConfigExtendsValue(input: {
  readonly configPath: string;
  readonly snapshotConfigPath: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly value: unknown;
}): { readonly changed: boolean; readonly value: unknown } {
  if (typeof input.value === "string") {
    const rewritten = rewriteTsConfigExtendsSpecifier({
      configPath: input.configPath,
      snapshotConfigPath: input.snapshotConfigPath,
      snapshotSourceRoot: input.snapshotSourceRoot,
      sourceRoot: input.sourceRoot,
      value: input.value,
    });

    return rewritten === undefined
      ? { changed: false, value: input.value }
      : { changed: true, value: rewritten };
  }

  if (!Array.isArray(input.value)) {
    return { changed: false, value: input.value };
  }

  let changed = false;
  const rewrittenValues = input.value.map((value) => {
    if (typeof value !== "string") {
      return value;
    }

    const rewritten = rewriteTsConfigExtendsSpecifier({
      configPath: input.configPath,
      snapshotConfigPath: input.snapshotConfigPath,
      snapshotSourceRoot: input.snapshotSourceRoot,
      sourceRoot: input.sourceRoot,
      value,
    });

    if (rewritten === undefined) {
      return value;
    }

    changed = true;
    return rewritten;
  });

  return {
    changed,
    value: rewrittenValues,
  };
}

function rewriteTsConfigExtendsSpecifier(input: {
  readonly configPath: string;
  readonly snapshotConfigPath: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly value: string;
}): string | undefined {
  if (!isTsConfigFilePath(input.value) || !isAbsoluteFilePath(input.value)) {
    return undefined;
  }

  const targetPath = resolveFirstExistingTsConfigExtendsTarget({
    configPath: input.configPath,
    extendsSpecifier: input.value,
  });

  if (targetPath === undefined || !isPathInsideOrEqual(targetPath, input.sourceRoot)) {
    return undefined;
  }

  return toDevelopmentSourceSnapshotPath({
    snapshotSourceRoot: input.snapshotSourceRoot,
    sourcePath: targetPath,
    sourceRoot: input.sourceRoot,
  });
}

async function createSnapshotSymlinks(plan: DevelopmentSourceSnapshotPlan): Promise<void> {
  for (const symlinkEntry of plan.symlinks) {
    const snapshotLinkPath = toSnapshotPathForPlan(plan, symlinkEntry.linkPath);
    const targetPath =
      symlinkEntry.targetKind === "local"
        ? toSnapshotPathForPlan(plan, symlinkEntry.targetPath)
        : symlinkEntry.targetPath;
    const relativeTarget =
      symlinkEntry.targetKind === "local"
        ? relative(dirname(snapshotLinkPath), targetPath) || "."
        : targetPath;

    await mkdir(dirname(snapshotLinkPath), { recursive: true });
    await symlink(relativeTarget, snapshotLinkPath, "junction");
  }
}

async function ensureRuntimePackageJson(plan: DevelopmentSourceSnapshotPlan): Promise<void> {
  const runtimePackageJsonPath = join(plan.runtimeAppRoot, "package.json");

  if (existsSync(runtimePackageJsonPath)) {
    return;
  }

  await mkdir(plan.runtimeAppRoot, { recursive: true });
  await writeFile(
    runtimePackageJsonPath,
    `${JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
}

async function validateDevelopmentSourceSnapshot(
  plan: DevelopmentSourceSnapshotPlan,
): Promise<void> {
  const runtimePackageJsonPath = join(plan.runtimeAppRoot, "package.json");

  if (!existsSync(runtimePackageJsonPath)) {
    throw new DevelopmentRuntimeSourceSnapshotError(
      `Development runtime source snapshot is missing the runtime app package.json at "${runtimePackageJsonPath}".`,
    );
  }

  for (const configPath of plan.tsconfigPaths) {
    const snapshotConfigPath = toSnapshotPathForPlan(plan, configPath);

    if (!existsSync(snapshotConfigPath)) {
      throw new DevelopmentRuntimeSourceSnapshotError(
        `Development runtime source snapshot is missing tsconfig dependency "${snapshotConfigPath}".`,
      );
    }

    await validateSnapshotTsConfigExtends(snapshotConfigPath);
  }
}

async function validateSnapshotTsConfigExtends(configPath: string): Promise<void> {
  const source = await readFile(configPath, "utf8");
  const extendsSpecifiers = extractTsConfigExtendsSpecifiers(source);

  for (const extendsSpecifier of extendsSpecifiers) {
    if (!isTsConfigFilePath(extendsSpecifier)) {
      continue;
    }

    const candidates = resolveTsConfigExtendsTargetPaths({
      configPath,
      extendsSpecifier,
    });

    if (candidates.some((candidate) => existsSync(candidate))) {
      continue;
    }

    throw new DevelopmentRuntimeSourceSnapshotError(
      `Development runtime source snapshot cannot resolve tsconfig extends "${extendsSpecifier}" from "${configPath}".`,
    );
  }
}

function toSnapshotPathForPlan(plan: DevelopmentSourceSnapshotPlan, sourcePath: string): string {
  return toDevelopmentSourceSnapshotPath({
    snapshotSourceRoot: plan.snapshotSourceRoot,
    sourcePath,
    sourceRoot: plan.sourceRoot,
  });
}

function isPathInsideOrEqual(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);

  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
