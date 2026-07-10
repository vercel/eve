import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { discoverAgent } from "#discover/discover-agent.js";
import { packageStateNamespace } from "#discover/extensions.js";
import { discoverFlatModuleSource, readSortedDirectoryEntries } from "#discover/grammar.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import { bundleAuthoredModuleCode } from "#internal/authored-module-loader.js";

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
  const shortName = safeJsIdentifier(bareName);
  return {
    sourceRoot: resolve(appRoot, extensionRoot),
    packageName,
    shortName,
  };
}

/** One managed subpath export: runnable JS plus its declaration barrel. */
interface ManagedExportTarget {
  readonly types: string;
  readonly default: string;
}

/** Subpath exports `eve extension build` manages for an extension package. */
const MANAGED_EXTENSION_EXPORTS: Readonly<Record<string, ManagedExportTarget>> = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
  "./tools": { types: "./dist/tools/index.d.ts", default: "./dist/tools/index.mjs" },
};

/**
 * Normalizes the extension package's `exports` map to the entries the build
 * emits so authors never hand-list them. eve owns these two subpaths, so a stale
 * value (e.g. the earlier bare-string `"./dist/index.mjs"`) is upgraded to the
 * `{ types, default }` shape; `package.json` is rewritten only when something changed.
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
    const current = exports[subpath];
    const matches =
      typeof current === "object" &&
      current !== null &&
      (current as ManagedExportTarget).types === target.types &&
      (current as ManagedExportTarget).default === target.default;
    if (!matches) {
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
 * Builds an extension package: emits `dist/index.mjs` (the mount factory) and
 * `dist/tools/index.mjs` (named tool re-exports for consumer overrides), and
 * fills the package `exports` map. Re-exports point at the authored source so the
 * consumer's compiled tools and the mount share one handle instance.
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

  // The package is loaded by Node natively when installed (its `.`/`./tools`
  // specifiers are externalized), so the entrypoints must be runnable JS with the
  // extension's namespace baked in — bundle them from source rather than
  // re-exporting `.ts`. `defineState`/`defineExtension` scope to the same
  // package-derived namespace the consumer applies to the source-recompiled
  // contributions, so the mount binding and its tools agree on the config key.
  const scopeNamespace = packageStateNamespace(config.packageName);

  const specifierFrom = (fromDir: string, logicalPath: string): string => {
    const rel = relative(fromDir, join(config.sourceRoot, logicalPath)).replaceAll("\\", "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  };

  const declarationSpecifier = specifierFrom(outDir, declarationModule.logicalPath);
  await emitEntrypoint({
    entryPath: join(outDir, "index.mjs"),
    typesPath: join(outDir, "index.d.ts"),
    reexports: [
      { name: "default", specifier: declarationSpecifier },
      { name: config.shortName, specifier: declarationSpecifier },
    ],
    scopeNamespace,
  });

  await emitEntrypoint({
    entryPath: join(outDir, "tools", "index.mjs"),
    typesPath: join(outDir, "tools", "index.d.ts"),
    reexports: manifest.tools.map((tool) => ({
      name: toolExportName(tool.logicalPath),
      specifier: specifierFrom(join(outDir, "tools"), tool.logicalPath),
    })),
    scopeNamespace,
  });

  await ensureExtensionExports(appRoot);

  return outDir;
}

/** One `export { <name> } from "<specifier>"` line an entrypoint barrel emits. */
interface Reexport {
  /** Export binding; `"default"` emits the bare `export { default } from …`. */
  readonly name: string;
  readonly specifier: string;
}

/**
 * Emits one Node-facing entrypoint: a self-contained runnable `.mjs` (bundled
 * from the authored source with the extension namespace baked in) and a `.d.ts`
 * barrel whose type re-exports resolve into the shipped `extension/` source.
 */
async function emitEntrypoint(input: {
  readonly entryPath: string;
  readonly typesPath: string;
  readonly reexports: readonly Reexport[];
  readonly scopeNamespace: string;
}): Promise<void> {
  const header = "// Generated by eve. Do not edit by hand.";
  const line = (reexport: Reexport, specifier: string): string =>
    reexport.name === "default"
      ? `export { default } from ${JSON.stringify(specifier)};`
      : `export { default as ${reexport.name} } from ${JSON.stringify(specifier)};`;

  const barrel = [header, "", ...input.reexports.map((r) => line(r, r.specifier)), ""].join("\n");
  await writeFile(input.entryPath, barrel, "utf8");
  await writeFile(
    input.entryPath,
    await bundleAuthoredModuleCode(input.entryPath, {
      extensionScopeNamespace: input.scopeNamespace,
    }),
    "utf8",
  );

  const declaration = [
    header,
    "",
    ...input.reexports.map((r) => line(r, toDeclarationSpecifier(r.specifier))),
    "",
  ].join("\n");
  await writeFile(input.typesPath, declaration, "utf8");
}

/**
 * Rewrites a bundle specifier to the form a `.d.ts` re-export resolves for types,
 * so declarations resolve into the shipped `.ts` source (`../extension/x.ts` → `../extension/x.js`).
 */
function toDeclarationSpecifier(specifier: string): string {
  return specifier
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs")
    .replace(/\.tsx?$/, ".js");
}

function toolExportName(logicalPath: string): string {
  let name = logicalPath;
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (name.endsWith(extension)) {
      name = name.slice(0, name.length - extension.length);
      break;
    }
  }
  return safeJsIdentifier(name.replace(/^tools\//, ""));
}

/**
 * Coerces a name into a valid JS identifier for a generated
 * `export { default as … }` binding — otherwise a tool like `get-weather.ts`
 * would emit the invalid binding `export { default as get-weather }`.
 */
function safeJsIdentifier(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}
