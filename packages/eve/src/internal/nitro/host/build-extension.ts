import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { discoverAgent } from "#discover/discover-agent.js";
import { discoverFlatModuleSource, readSortedDirectoryEntries } from "#discover/grammar.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";

/**
 * Resolved build inputs for an extension package (a `package.json` declaring
 * `eve.extension`).
 */
export interface ExtensionBuildConfig {
  /** Absolute path to the agent-shaped source root (`eve.extension`). */
  readonly sourceRoot: string;
  /** Package name from `package.json`. */
  readonly packageName: string;
  /** Short name a consumer mounts by (`@acme/crm` → `crm`). */
  readonly shortName: string;
}

/**
 * Reads `package.json#eve.extension` from a project root, returning the
 * extension build inputs or `null` when the package is a regular agent app.
 */
export async function tryReadExtensionBuildConfig(
  rootDir: string,
): Promise<ExtensionBuildConfig | null> {
  const appRoot = resolve(rootDir);
  let pkg: { name?: unknown; eve?: { extension?: unknown } };
  try {
    pkg = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return null;
  }

  const extensionRoot = pkg.eve?.extension;
  if (typeof extensionRoot !== "string" || extensionRoot.length === 0) {
    return null;
  }

  const packageName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : "extension";
  const bareName = packageName.slice(packageName.lastIndexOf("/") + 1);
  const shortName = /^[A-Za-z_$]/.test(bareName)
    ? bareName.replace(/[^A-Za-z0-9_$]/g, "_")
    : `_${bareName.replace(/[^A-Za-z0-9_$]/g, "_")}`;
  return {
    sourceRoot: resolve(appRoot, extensionRoot),
    packageName,
    shortName,
  };
}

/** Subpath exports `eve build` manages for an extension package. */
const MANAGED_EXTENSION_EXPORTS: Readonly<Record<string, string>> = {
  ".": "./dist/index.mjs",
  "./tools": "./dist/tools/index.mjs",
};

/**
 * Fills the extension package's `exports` map with the entries the build emits —
 * `.` (the mount factory) and `./tools` (tool re-exports for overrides) — so
 * authors never hand-list them. Only missing keys are added, so an author who
 * deliberately customizes an entry keeps it. Rewrites `package.json` only when a
 * key was added.
 */
async function ensureExtensionExports(appRoot: string): Promise<void> {
  const pkgPath = join(appRoot, "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;

  const exports =
    typeof pkg.exports === "object" && pkg.exports !== null && !Array.isArray(pkg.exports)
      ? (pkg.exports as Record<string, unknown>)
      : {};

  let changed = false;
  for (const [subpath, target] of Object.entries(MANAGED_EXTENSION_EXPORTS)) {
    if (!(subpath in exports)) {
      exports[subpath] = target;
      changed = true;
    }
  }

  if (!changed) {
    return;
  }
  pkg.exports = exports;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * Builds an extension package: emits `dist/index.mjs` (the mount factory,
 * re-exporting the extension's `defineExtension` handle as `default` and its
 * short name) and `dist/tools/index.mjs` (named tool re-exports for consumer
 * overrides). Re-exports point at the authored source so the consumer's compiled
 * tools and the mount share one handle instance. Also fills the package's
 * `exports` map with these entries so authors do not hand-list them.
 */
export async function buildExtensionPackage(
  rootDir: string,
  config: ExtensionBuildConfig,
): Promise<string> {
  const appRoot = resolve(rootDir);
  const source = createDiskProjectSource();

  const { diagnostics, manifest } = await discoverAgent({
    agentRoot: config.sourceRoot,
    appRoot,
    source,
    role: "extension",
  });
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Cannot build extension "${config.packageName}":\n${errors
        .map((diagnostic) => `  - ${diagnostic.message}`)
        .join("\n")}`,
    );
  }

  const rootEntries = await readSortedDirectoryEntries(source, config.sourceRoot);
  const declarationModule = discoverFlatModuleSource({
    rootEntries,
    rootPath: config.sourceRoot,
    slotName: "extension",
  }).module;

  if (declarationModule === undefined) {
    throw new Error(
      `Cannot build extension "${config.packageName}": its source root "${config.sourceRoot}" is missing an "extension.<ext>" declaration. Add \`export default defineExtension(...)\` there (with or without config).`,
    );
  }

  const outDir = join(appRoot, "dist");
  await mkdir(join(outDir, "tools"), { recursive: true });

  const specifierFrom = (fromDir: string, logicalPath: string): string => {
    const rel = relative(fromDir, join(config.sourceRoot, logicalPath)).replaceAll("\\", "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  };

  // Every extension declares itself with `defineExtension`, so the mount default
  // is always that handle — re-export it (and the short name a consumer imports).
  const declarationSpecifier = specifierFrom(outDir, declarationModule.logicalPath);
  const indexLines = [
    "// Generated by eve. Do not edit by hand.",
    "",
    `export { default } from ${JSON.stringify(declarationSpecifier)};`,
    `export { default as ${config.shortName} } from ${JSON.stringify(declarationSpecifier)};`,
  ];
  await writeFile(join(outDir, "index.mjs"), `${indexLines.join("\n")}\n`, "utf8");

  const toolLines = ["// Generated by eve. Do not edit by hand.", ""];
  for (const tool of manifest.tools) {
    const specifier = specifierFrom(join(outDir, "tools"), tool.logicalPath);
    toolLines.push(
      `export { default as ${toolExportName(tool.logicalPath)} } from ${JSON.stringify(specifier)};`,
    );
  }
  await writeFile(join(outDir, "tools", "index.mjs"), `${toolLines.join("\n")}\n`, "utf8");

  await ensureExtensionExports(appRoot);

  return outDir;
}

function toolExportName(logicalPath: string): string {
  let name = logicalPath;
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (name.endsWith(extension)) {
      name = name.slice(0, name.length - extension.length);
      break;
    }
  }
  return name.replace(/^tools\//, "").replaceAll("/", "_");
}
