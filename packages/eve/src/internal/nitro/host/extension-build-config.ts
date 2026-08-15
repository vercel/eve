import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { parseExtensionPackageRoots } from "#shared/extension-package-contract.js";

/** Resolved producer inputs for an extension package. */
export interface ExtensionBuildConfig {
  /** Absolute authoring root from `eve.extension.source`. */
  readonly sourceRoot: string;
  /** Absolute agent-shaped distribution root from `eve.extension.dist`. */
  readonly distRoot: string;
  /** Directory containing the dist root and generated package entrypoints. */
  readonly outDir: string;
  readonly packageName: string;
  /** Short package name used for the generated named mount export. */
  readonly shortName: string;
  /** Packages allowed to remain as imports in the published distribution. */
  readonly runtimeDependencies: readonly string[];
}

/** Reads and validates the extension producer contract from `package.json`. */
export async function tryReadExtensionBuildConfig(
  rootDir: string,
): Promise<ExtensionBuildConfig | null> {
  const appRoot = resolve(rootDir);
  let pkg: {
    name?: unknown;
    eve?: { extension?: unknown };
    dependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
  };
  try {
    pkg = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return null;
  }

  const extension = parseExtensionPackageRoots(pkg.eve?.extension);
  if (extension === null) {
    return null;
  }
  if (extension.source === undefined) {
    throw new Error(
      "`eve.extension.dist` is declared without `eve.extension.source`. Building an extension requires the authoring root; add `eve.extension.source` to package.json.",
    );
  }

  const sourceRoot = resolve(appRoot, extension.source);
  const distRoot = resolve(appRoot, extension.dist);
  const outDir = dirname(distRoot);
  assertManagedPackagePath(appRoot, sourceRoot, "eve.extension.source");
  assertManagedPackagePath(appRoot, distRoot, "eve.extension.dist");
  assertManagedPackagePath(appRoot, outDir, "eve.extension.dist output directory");
  if (sourceRoot === distRoot) {
    throw new Error("`eve.extension.source` and `eve.extension.dist` must be different paths.");
  }
  if (
    sourceRoot === outDir ||
    sourceRoot.startsWith(`${outDir}${sep}`) ||
    outDir.startsWith(`${sourceRoot}${sep}`)
  ) {
    throw new Error("`eve.extension.source` and the managed dist output cannot overlap.");
  }

  const packageName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : "extension";
  const bareName = packageName.slice(packageName.lastIndexOf("/") + 1);
  return {
    sourceRoot,
    distRoot,
    outDir,
    packageName,
    shortName: safeJsIdentifier(bareName),
    runtimeDependencies: [
      ...new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]),
    ].sort(),
  };
}

/** Ensures package exports point at the build output's generated entrypoints. */
export async function ensureExtensionExports(appRoot: string, outDir: string): Promise<void> {
  const pkgPath = join(appRoot, "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const outputPath = relative(appRoot, outDir).replaceAll("\\", "/");
  const prefix = outputPath.startsWith(".") ? outputPath : `./${outputPath}`;
  const managed = {
    ".": { types: `${prefix}/index.d.ts`, default: `${prefix}/index.mjs` },
    "./tools": {
      types: `${prefix}/tools/index.d.ts`,
      default: `${prefix}/tools/index.mjs`,
    },
  } as const;
  const exports =
    typeof pkg.exports === "object" && pkg.exports !== null && !Array.isArray(pkg.exports)
      ? (pkg.exports as Record<string, unknown>)
      : {};

  let changed = false;
  for (const [subpath, target] of Object.entries(managed)) {
    const current = exports[subpath];
    const matches =
      typeof current === "object" &&
      current !== null &&
      (current as { types?: unknown }).types === target.types &&
      (current as { default?: unknown }).default === target.default;
    if (!matches) {
      exports[subpath] = target;
      changed = true;
    }
  }
  if (changed) {
    pkg.exports = exports;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }
}

function assertManagedPackagePath(appRoot: string, path: string, field: string): void {
  const rel = relative(appRoot, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`\`${field}\` must point to a directory inside the extension package.`);
  }
}

function safeJsIdentifier(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}
