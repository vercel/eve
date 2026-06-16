/**
 * Shared library powering `scripts/vendor-compiled.mjs` and the per-package
 * configs in this directory. The pieces are written so other packages in
 * the monorepo can adopt the same vendoring pipeline without eve-specific
 * coupling — `runVendor` and `createDeclarationCopier` are the two public
 * entry points other consumers should reach for.
 *
 * Module config schema (each per-package file `export default`s one of these):
 *
 * ```
 * {
 *   packageName: string,           // npm package to resolve via require
 *   compiledPath: string,          // subdir under compiledRoot to write into
 *
 *   // Declaration emission (pick one)
 *   declaration?: string,          // inline .d.ts content
 *   copyDeclarations?: (ctx) => Promise<void>,  // dynamic .d.ts writer
 *
 *   // JS bundling
 *   entry?: string,                // package-relative entry path
 *   entries?: Array<{              // multi-entry packages
 *     entry?: string,
 *     input?: string,
 *     outputPath: string,
 *     declaration?: string,
 *   }>,
 *   external?: string[] | (source: string) => boolean,
 *   plugins?: Plugin[],
 *   loader?: Record<string, string>,
 *   resolve?: ResolveOptions,
 *   bundling?: "shared" | "standalone",  // default "shared"
 *   chunkGroup?: string,                  // default "node"
 *   typeOnly?: boolean,                   // skips JS bundling entirely
 * }
 * ```
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, parse, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWithNitroRolldown } from "../nitro-rolldown.mjs";
import { createVendoredDependencyWarningFilter } from "../vendor-warning-log.mjs";

const declarationsDir = fileURLToPath(new URL("./declarations/", import.meta.url));
const require = createRequire(import.meta.url);

// ───────────────────────────────────────────────────────────────────────────
// Per-package authoring API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reads a `.d.ts` file from `scripts/vendor-compiled/declarations/` and
 * returns its contents. Per-package configs use this to keep declaration
 * strings as real `.d.ts` files (with editor syntax highlighting and lint
 * support) instead of inline template literals.
 *
 * @param {string} relativePath path relative to `declarations/`
 * @returns {Promise<string>}
 */
export async function loadDeclaration(relativePath) {
  return readFile(join(declarationsDir, relativePath), "utf8");
}

/**
 * Builds a `copyDeclarations` callback that copies a package's `.d.ts`
 * files straight from the installed dependency into the vendored output,
 * applying per-module rewrite rules so external imports resolve.
 *
 * Use this when a package's surface is part of eve's public type contract
 * (e.g. `chat`, where `ctx.thread.refresh()` is reached by user code) —
 * hand-written stubs silently drift on every version bump.
 *
 * Rewrite rules name the external modules the upstream `.d.ts` imports
 * from. Three kinds are supported:
 *
 *   `external` — leaves the import untouched. Use this for packages that are
 *     already part of eve's public dependency surface, such as `ai`.
 *   `vendored` — rewrites `from '<moduleName>'` to a `#compiled/<...>`
 *     specifier so the dependency resolves against eve's own vendored copy.
 *     This works even when one vendored package's `.d.ts` references another
 *     (e.g. `@workflow/core` → `@workflow/world` → `zod`) because vendored
 *     directories intentionally carry no `package.json` to shadow eve's
 *     `#compiled/*` imports map (see `prepareCompiledModule`).
 *   `stub` — emits a tiny local stub `.d.ts` next to the copied file and
 *     rewrites the import to point at it. The `build` callback receives
 *     the set of names imported from `moduleName` so it can emit just the
 *     declarations the upstream actually references.
 *
 * Any external the upstream references but no rule covers is a hard error:
 * the script refuses to silently fall back so the next version bump can't
 * sneak a new dependency past us.
 *
 * `files` can override the default `dist/index.d.ts` copy. Use it for
 * packages whose entrypoint declaration imports sibling declaration files,
 * or for multi-entry packages that need their upstream declaration tree.
 *
 * `discoverExtraFiles` is consulted for chunk files the upstream `.d.ts`
 * references by relative path (e.g. chat's `./jsx-runtime-<hash>.d.ts`).
 * Each returned filename is co-copied verbatim into the destination.
 */
export function createDeclarationCopier({ rewrites = {}, discoverExtraFiles, files } = {}) {
  return async ({ destinationRoot, packageInfo }) => {
    const distDir = join(packageInfo.packageRoot, "dist");
    const distEntries = await readdir(distDir);
    const declarationFiles =
      typeof files === "function"
        ? await files({ distDir, distEntries, packageInfo })
        : Array.isArray(files)
          ? files
          : [{ source: "index.d.ts", output: "index.d.ts" }];

    const declarations = await Promise.all(
      declarationFiles.map(async (file) => ({
        ...file,
        sourceText: await readFile(join(distDir, file.source), "utf8"),
      })),
    );
    const externals = mergeExternalDeclarationImports(
      declarations.map((declaration) => declaration.sourceText),
    );

    for (const [moduleName, names] of externals) {
      const rule = rewrites[moduleName];
      if (rule === undefined) {
        throw new Error(
          `Vendor: ${packageInfo.packageJson.name}'s .d.ts imports from "${moduleName}", ` +
            `which has no rewrite rule. Add one to copyDeclarations' rewrites map ` +
            `before bumping ${packageInfo.packageJson.name}.`,
        );
      }

      if (rule.kind === "external") {
        continue;
      }

      if (rule.kind === "vendored") {
        for (const declaration of declarations) {
          declaration.sourceText = rewriteImportSource(
            declaration.sourceText,
            moduleName,
            `#compiled/${rule.compiledPath}/index.js`,
          );
        }
      } else if (rule.kind === "stub") {
        await writeFile(
          join(destinationRoot, `${rule.stubBaseName}.d.ts`),
          rule.build(names, moduleName),
          "utf8",
        );
        for (const declaration of declarations) {
          declaration.sourceText = rewriteImportSource(
            declaration.sourceText,
            moduleName,
            relativeDeclarationSpecifier(declaration.output, `${rule.stubBaseName}.js`),
          );
        }
      } else {
        throw new Error(`Vendor: unknown rewrite rule kind "${rule.kind}" for "${moduleName}".`);
      }
    }

    await Promise.all(
      declarations.map(async (declaration) => {
        const outputPath = join(destinationRoot, declaration.output);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, declaration.sourceText, "utf8");
      }),
    );

    if (typeof discoverExtraFiles === "function") {
      const extras = discoverExtraFiles(distEntries);
      await Promise.all(
        extras.map(async (file) => {
          const outputPath = join(destinationRoot, file);
          await mkdir(dirname(outputPath), { recursive: true });
          await copyFile(join(distDir, file), outputPath);
        }),
      );
    }
  };
}

function mergeExternalDeclarationImports(sources) {
  const result = new Map();
  for (const source of sources) {
    for (const [moduleName, names] of collectExternalDeclarationImports(source)) {
      let mergedNames = result.get(moduleName);
      if (mergedNames === undefined) {
        mergedNames = new Set();
        result.set(moduleName, mergedNames);
      }
      for (const name of names) {
        mergedNames.add(name);
      }
    }
  }
  return result;
}

function relativeDeclarationSpecifier(fromOutputPath, targetFileName) {
  const fromDirectory = posix.dirname(fromOutputPath);
  const fromBase = fromDirectory === "." ? "." : fromDirectory;
  const specifier = posix.relative(fromBase, targetFileName);
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

/**
 * Returns `Map<externalModuleName, Set<importedName>>` for every
 * `import { ... } from '<external>'`, `export { ... } from '<external>'`,
 * and `import * as <alias> from '<external>'` in a TypeScript declaration
 * source. Local relative paths and `#compiled/*` specifiers are skipped —
 * only bare module specifiers appear in the map.
 *
 * `as`-renames are flattened to the original left-side name so the stub
 * exports the symbol the upstream actually references.
 *
 * For `import * as <alias> from '<external>'`, the source is scanned for
 * `<alias>.<Name>` accesses and each `<Name>` is added to the module's
 * name set. This lets a `stub` rewrite rule emit declarations only for
 * the namespace members the upstream `.d.ts` actually reaches into.
 */
export function collectExternalDeclarationImports(source) {
  const namedPattern = /^(?:import|export)\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];/gm;
  const namespacePattern =
    /^import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];/gm;
  const result = new Map();

  const isExternal = (moduleName) =>
    !moduleName.startsWith(".") &&
    !moduleName.startsWith("/") &&
    !moduleName.startsWith("#") &&
    !moduleName.startsWith("node:");

  const addName = (moduleName, name) => {
    if (!isExternal(moduleName)) {
      return;
    }
    let names = result.get(moduleName);
    if (names === undefined) {
      names = new Set();
      result.set(moduleName, names);
    }
    if (name !== undefined && name.length > 0) {
      names.add(name);
    }
  };

  for (const match of source.matchAll(namedPattern)) {
    const namesPart = match[1];
    const moduleName = match[2];
    if (!isExternal(moduleName)) {
      continue;
    }
    for (const entry of namesPart.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const original = trimmed
        .split(/\s+as\s+/u)[0]
        .trim()
        .replace(/^type\s+/u, "");
      if (original.length > 0) {
        addName(moduleName, original);
      }
    }
  }

  for (const match of source.matchAll(namespacePattern)) {
    const alias = match[1];
    const moduleName = match[2];
    if (!isExternal(moduleName)) {
      continue;
    }
    // Register the module even if no members are reached so unknown
    // namespace imports surface as a missing rewrite rule.
    addName(moduleName);
    const memberPattern = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g");
    for (const memberMatch of source.matchAll(memberPattern)) {
      addName(moduleName, memberMatch[1]);
    }
  }

  return result;
}

/**
 * Rewrites every `from '<moduleName>'` (and the `"`-quoted variant) in
 * a declaration source to `from '<replacement>'`. Used to redirect copied
 * `.d.ts` imports at locally-vendored stubs or `#compiled/*` re-vendoring.
 */
export function rewriteImportSource(source, moduleName, replacement) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source
    .replaceAll(new RegExp(`from '${escaped}'`, "g"), `from '${replacement}'`)
    .replaceAll(new RegExp(`from "${escaped}"`, "g"), `from "${replacement}"`);
}

/**
 * Generic stub builder: emits `export declare const <name>: unique symbol;`
 * for every name in `names`. Use as the `build` callback of a `stub`
 * rewrite rule for upstream modules that only export unique symbols
 * (e.g. `@workflow/serde`).
 */
export function buildUniqueSymbolStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` symbols referenced by a vendored .d.ts.`,
    `// Emitted by createDeclarationCopier > buildUniqueSymbolStub.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    lines.push(`export declare const ${name}: unique symbol;`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Generic stub builder: emits `export type <name> = unknown;` for every
 * name in `names`. Use as the `build` callback of a `stub` rewrite rule
 * for upstream modules whose types we deliberately opaque-out so consumers
 * don't have to install the @types package just to typecheck against eve
 * (e.g. `mdast`).
 */
export function buildOpaqueTypesStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by createDeclarationCopier > buildOpaqueTypesStub.`,
    `//`,
    `// Names are aliased to \`unknown\` so consumers don't have to install`,
    `// upstream @types just to typecheck against eve. If real types are`,
    `// needed in user code, install the upstream @types and use them directly.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    lines.push(`export type ${name} = unknown;`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * rolldown plugin factory: short-circuits resolution of optional native
 * dependencies that aren't shipped in the vendored bundle. The stub
 * throws if anything ever imports it at runtime — vendored consumers
 * never hit that path, so this just keeps the bundler from trying to
 * inline a native dependency it can't resolve.
 */
export function createOptionalNativeStubPlugin(packageNames) {
  const packageNameSet = new Set(packageNames);

  return {
    name: "eve-optional-native-stub",
    resolveId(source) {
      if (!packageNameSet.has(source)) {
        return undefined;
      }
      return `eve-optional-native-stub:${source}`;
    },
    load(id) {
      if (!id.startsWith("eve-optional-native-stub:")) {
        return undefined;
      }
      const packageName = id.slice("eve-optional-native-stub:".length);
      return {
        code: `throw new Error(${JSON.stringify(
          `Optional native dependency "${packageName}" is not bundled in this vendored module.`,
        )});\nexport {};\n`,
        moduleType: "js",
      };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator
// ───────────────────────────────────────────────────────────────────────────

/**
 * Top-level vendor runner. Other packages in the monorepo can call this
 * with their own `modules` and roots to vendor their own deps without
 * duplicating any of this pipeline.
 *
 * @param {object} options
 * @param {string} options.packageRoot
 *   Root of the calling package (used to resolve `node_modules`).
 * @param {string} options.compiledRoot
 *   Where vendored output is written. Typically `.generated/compiled/`.
 * @param {Array<object>} options.modules
 *   Module configs. `typeOnly: true` entries skip JS bundling.
 * @param {string[]} options.scriptFiles
 *   Files whose content contributes to the stamp fingerprint. When any of
 *   these files changes the cached stamp is invalidated and vendoring re-runs.
 *   Pass everything that influences the output: the orchestrator entry script,
 *   the `_shared.mjs` library, per-package configs, and `.d.ts` declarations.
 */
export async function runVendor({ packageRoot, compiledRoot, modules, scriptFiles }) {
  const stampPath = join(compiledRoot, ".vendor-stamp.json");
  const lockPath = join(compiledRoot, ".vendor-lock");

  await mkdir(compiledRoot, { recursive: true });

  const desiredStamp = await computeStamp({ scriptFiles, modules, packageRoot });

  if (stampMatches(desiredStamp, await readExistingStamp(stampPath))) {
    console.log("Compiled vendor modules are already up to date.");
    return;
  }

  await acquireLock(lockPath);
  try {
    // A peer process may have completed while we waited for the lock.
    if (stampMatches(desiredStamp, await readExistingStamp(stampPath))) {
      console.log("Compiled vendor modules are already up to date.");
      return;
    }

    const bundledModules = modules.filter((module) => module.typeOnly !== true);
    const typeOnlyModules = modules.filter((module) => module.typeOnly === true);

    await pruneStaleCompiledEntries({ compiledRoot, modules });
    await bundleModules({ modules: bundledModules, packageRoot, compiledRoot });

    for (const module of typeOnlyModules) {
      await writeTypeOnlyModule({ module, compiledRoot, packageRoot });
    }

    await writeFile(stampPath, `${JSON.stringify(desiredStamp, null, 2)}\n`, "utf8");

    const compiledPaths = modules
      .map((module) => relative(packageRoot, join(compiledRoot, module.compiledPath)))
      .join(", ");
    console.log(`Updated compiled vendor modules: ${compiledPaths}`);
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Removes top-level entries under `compiledRoot` that no configured module
 * claims, so output for vendored packages that were since removed (for
 * example `just-bash`) does not linger on incremental dev machines and get
 * copied into `dist/`.
 */
async function pruneStaleCompiledEntries({ compiledRoot, modules }) {
  const expected = new Set(["_chunks", ".vendor-stamp.json", ".vendor-lock"]);
  for (const module of modules) {
    const [topLevelSegment] = module.compiledPath.split("/");
    expected.add(topLevelSegment);
  }

  let entries;
  try {
    entries = await readdir(compiledRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (expected.has(entry.name)) continue;
    await rm(join(compiledRoot, entry.name), { recursive: true, force: true });
  }
}

/**
 * Walks `dir` recursively and returns absolute paths for every file
 * matching one of `extensions` (e.g. `[".mjs", ".d.ts"]`). Used by
 * orchestrators to build a `scriptFiles` list for `runVendor`.
 */
export async function collectFilesRecursively(dir, extensions) {
  const out = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(fullPath);
      }
    }
  };
  await visit(dir);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────────

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findPackageJson(packageName, packageRoot) {
  let currentPath;
  try {
    currentPath = dirname(require.resolve(packageName, { paths: [packageRoot] }));
  } catch {
    const packageJsonPath = join(
      packageRoot,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );

    if (await pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (packageJson.name === packageName) {
        return {
          packageJson,
          packageJsonPath,
          packageRoot: dirname(packageJsonPath),
        };
      }
    }
    throw new Error(`Could not resolve "${packageName}".`);
  }

  while (currentPath !== parse(currentPath).root) {
    const packageJsonPath = join(currentPath, "package.json");
    if (await pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (packageJson.name === packageName) {
        return {
          packageJson,
          packageJsonPath,
          packageRoot: currentPath,
        };
      }
    }
    currentPath = dirname(currentPath);
  }

  throw new Error(`Could not find package.json for "${packageName}".`);
}

async function copyLicense(sourceRoot, destinationRoot) {
  const entries = await readdir(sourceRoot);
  const licenseFileName = entries.find((entry) => /^licen[cs]e(?:\..*)?$/i.test(entry));
  if (!licenseFileName) {
    return;
  }
  await copyFile(join(sourceRoot, licenseFileName), join(destinationRoot, licenseFileName));
}

async function prepareCompiledModule({ module, compiledRoot, packageRoot }) {
  const destinationRoot = join(compiledRoot, module.compiledPath);
  const packageInfo = await findPackageJson(module.packageName, packageRoot);

  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  // Deliberately no per-package `package.json`. Each vendored directory lives
  // under eve (which is `"type": "module"`), so the bundled ESM `.js` inherits
  // the right module type without one. More importantly, writing a package.json
  // here would create a package scope that shadows eve's `#compiled/*` imports
  // map: a `#compiled/<pkg>` specifier in one vendored `.d.ts` that references
  // another (e.g. `@workflow/core` → `@workflow/world`) would then fail to
  // resolve and silently degrade to `any` under `skipLibCheck`. Without the
  // shadowing file, resolution falls through to eve's root imports map and the
  // real upstream types flow across the vendored tree. The upstream LICENSE is
  // still copied below for attribution.
  await copyLicense(packageInfo.packageRoot, destinationRoot);

  return { destinationRoot, packageInfo };
}

function getModuleEntries(module, packageInfo) {
  if (Array.isArray(module.entries)) {
    return module.entries.map((entry) => ({
      declaration: entry.declaration,
      input:
        typeof entry.entry === "string"
          ? join(packageInfo.packageRoot, entry.entry)
          : typeof entry.input === "string"
            ? entry.input
            : typeof module.entry === "string"
              ? join(packageInfo.packageRoot, module.entry)
              : module.packageName,
      outputPath: entry.outputPath,
    }));
  }

  return [
    {
      declaration: module.declaration,
      input:
        typeof module.entry === "string"
          ? join(packageInfo.packageRoot, module.entry)
          : module.packageName,
      outputPath: "index",
    },
  ];
}

async function bundleStandaloneModule({ destinationRoot, module, packageInfo, packageRoot }) {
  const warningFilter = createVendoredDependencyWarningFilter();
  const entries = getModuleEntries(module, packageInfo);

  if (entries.length !== 1 || entries[0]?.outputPath !== "index") {
    throw new Error(
      `Standalone vendored module "${module.packageName}" must emit one index entry.`,
    );
  }

  await buildWithNitroRolldown({
    cwd: packageRoot,
    input: entries[0].input,
    external: module.external ?? [],
    moduleTypes: module.loader ?? {},
    platform: "node",
    plugins: module.plugins ?? [],
    resolve: module.resolve ?? {
      conditionNames: ["node", "import", "default"],
      mainFields: ["module", "main"],
    },
    treeshake: true,
    output: {
      banner: "/* oxlint-disable */",
      codeSplitting: false,
      comments: false,
      file: join(destinationRoot, "index.js"),
      format: "esm",
      minify: true,
      sourcemap: false,
    },
    onLog: warningFilter.onLog,
  });
}

async function bundleModuleGroup({ chunkGroup, preparedModules, packageRoot, compiledRoot }) {
  const warningFilter = createVendoredDependencyWarningFilter();
  const entrypoints = Object.fromEntries(
    preparedModules.flatMap(({ module, packageInfo }) =>
      getModuleEntries(module, packageInfo).map((entry) => [
        `${module.compiledPath}/${entry.outputPath}`,
        entry.input,
      ]),
    ),
  );

  const external = (source) =>
    preparedModules.some(({ module }) => {
      if (typeof module.external === "function") return module.external(source);
      if (Array.isArray(module.external)) return module.external.includes(source);
      return false;
    });

  const moduleTypes = Object.assign(
    {},
    ...preparedModules.map(({ module }) => module.loader ?? {}),
  );
  const plugins = preparedModules.flatMap(({ module }) => module.plugins ?? []);

  await buildWithNitroRolldown({
    cwd: packageRoot,
    input: entrypoints,
    external,
    moduleTypes,
    platform: "node",
    plugins,
    resolve: {
      conditionNames: ["node", "import", "default"],
      mainFields: ["module", "main"],
    },
    treeshake: true,
    output: {
      banner: "/* oxlint-disable */",
      chunkFileNames: `_chunks/${chunkGroup}/[name]-[hash].js`,
      comments: false,
      dir: compiledRoot,
      entryFileNames: "[name].js",
      format: "esm",
      minify: true,
      sourcemap: false,
    },
    onLog: warningFilter.onLog,
  });
}

async function bundleModules({ modules, packageRoot, compiledRoot }) {
  const preparedModules = await Promise.all(
    modules.map(async (module) => ({
      module,
      ...(await prepareCompiledModule({ module, compiledRoot, packageRoot })),
    })),
  );

  await rm(join(compiledRoot, "_chunks"), { recursive: true, force: true });

  const standalone = preparedModules.filter(({ module }) => module.bundling === "standalone");
  const shared = preparedModules.filter(({ module }) => module.bundling !== "standalone");
  const groups = Map.groupBy(shared, ({ module }) => module.chunkGroup ?? "node");

  await Promise.all(standalone.map((entry) => bundleStandaloneModule({ ...entry, packageRoot })));

  await Promise.all(
    [...groups].map(([chunkGroup, groupModules]) =>
      bundleModuleGroup({ chunkGroup, preparedModules: groupModules, packageRoot, compiledRoot }),
    ),
  );

  // Inline declaration strings go first so copyDeclarations callbacks can
  // overwrite them with the real package contents if both are present.
  await Promise.all(
    preparedModules.flatMap(({ destinationRoot, module, packageInfo }) =>
      getModuleEntries(module, packageInfo)
        .filter((entry) => typeof entry.declaration === "string")
        .map((entry) =>
          writeFile(join(destinationRoot, `${entry.outputPath}.d.ts`), entry.declaration, "utf8"),
        ),
    ),
  );

  for (const { destinationRoot, module, packageInfo } of preparedModules) {
    if (typeof module.copyDeclarations !== "function") continue;
    await module.copyDeclarations({ destinationRoot, packageInfo });
  }
}

async function writeTypeOnlyModule({ module, compiledRoot, packageRoot }) {
  const { destinationRoot, packageInfo } = await prepareCompiledModule({
    module,
    compiledRoot,
    packageRoot,
  });
  await writeFile(join(destinationRoot, "index.js"), "export {};\n", "utf8");

  if (typeof module.copyDeclarations === "function") {
    await module.copyDeclarations({ destinationRoot, packageInfo });
    return;
  }
  if (typeof module.declaration !== "string") {
    throw new Error(
      `Type-only vendored module "${module.packageName}" must define either a ` +
        `\`declaration\` string or a \`copyDeclarations\` callback.`,
    );
  }
  await writeFile(join(destinationRoot, "index.d.ts"), module.declaration, "utf8");
}

/**
 * Stable fingerprint of every input that drives the vendored output:
 * resolved package versions plus the content of every file in `scriptFiles`.
 * When the fingerprint matches the previously recorded stamp the work is
 * a no-op, which makes `build:compiled` safe to invoke concurrently from
 * sibling Turbo tasks without racing on shared destination directories.
 */
async function computeStamp({ scriptFiles, modules, packageRoot }) {
  const scriptHash = createHash("sha256");
  // Hash file contents in a deterministic order so identical inputs always
  // produce identical stamps.
  for (const file of [...scriptFiles].sort()) {
    const content = await readFile(file, "utf8");
    scriptHash.update(file);
    scriptHash.update("\0");
    scriptHash.update(content);
    scriptHash.update("\0");
  }

  const moduleVersions = {};
  for (const module of modules) {
    const { packageJson } = await findPackageJson(module.packageName, packageRoot);
    moduleVersions[module.packageName] = packageJson.version ?? "0.0.0";
  }

  return {
    moduleVersions,
    scriptHash: scriptHash.digest("hex"),
  };
}

async function readExistingStamp(stampPath) {
  try {
    return JSON.parse(await readFile(stampPath, "utf8"));
  } catch {
    return null;
  }
}

function stampMatches(a, b) {
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Acquires an exclusive filesystem lock by atomically creating a sentinel
 * directory. `mkdir` is atomic on every supported platform, so two
 * concurrent invocations cannot both succeed. A timestamp inside the lock
 * directory lets us recover from stale locks left behind by crashed
 * processes.
 */
async function acquireLock(lockPath, timeoutMs = 120_000) {
  const start = Date.now();

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }), "utf8");
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const lockStats = await stat(lockPath).catch(() => null);
    if (lockStats !== null && Date.now() - lockStats.mtime.getTime() > timeoutMs) {
      await rm(lockPath, { recursive: true, force: true });
      continue;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out after ${timeoutMs}ms acquiring vendor-compiled lock at ${lockPath}.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function releaseLock(lockPath) {
  await rm(lockPath, { recursive: true, force: true });
}
