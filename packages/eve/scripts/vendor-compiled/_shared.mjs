import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, parse, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWithRolldown } from "../rolldown.mjs";
import { onVendoredDependencyLog } from "../../src/internal/bundler/vendored-dependency-log.ts";

const declarationsDir = fileURLToPath(new URL("./declarations/", import.meta.url));
const require = createRequire(import.meta.url);
const ts = createRequire(require.resolve("@microsoft/api-extractor/package.json"))("typescript");

export async function loadDeclaration(relativePath) {
  return readFile(join(declarationsDir, relativePath), "utf8");
}

export function createDeclarationCopier({
  declarationRoot = "dist",
  rewrites = {},
  discoverExtraFiles,
  files,
} = {}) {
  return async ({ destinationRoot, packageInfo }) => {
    const distDir = join(packageInfo.packageRoot, declarationRoot);
    const distEntries = await readdir(distDir);
    const declarationFiles =
      typeof files === "function"
        ? await files({ distDir, distEntries, packageInfo })
        : Array.isArray(files)
          ? files
          : [{ source: "index.d.ts", output: "index.d.ts" }];

    const declarations = [];
    const queued = new Map(declarationFiles.map((file) => [file.source, file]));
    const extras = typeof discoverExtraFiles === "function" ? discoverExtraFiles(distEntries) : [];
    for (const file of extras.filter((file) => /\.d\.[cm]?ts$/u.test(file))) {
      if (!queued.has(file)) queued.set(file, { source: file, output: file });
    }
    for (const file of queued.values()) {
      const sourceText = await readFile(join(distDir, file.source), "utf8");
      declarations.push({ ...file, sourceText });
      for (const specifier of collectRelativeDeclarationReferences(sourceText)) {
        const candidates = /\.d\.[cm]?ts$/u.test(specifier)
          ? [specifier]
          : /\.[cm]?[jt]s$/u.test(specifier)
            ? [
                specifier
                  .replace(/\.[jt]s$/u, ".d.ts")
                  .replace(/\.m[jt]s$/u, ".d.mts")
                  .replace(/\.c[jt]s$/u, ".d.cts"),
              ]
            : [`${specifier}.d.ts`, `${specifier}/index.d.ts`];
        let resolved;
        for (const candidate of candidates) {
          const source = posix.normalize(posix.join(posix.dirname(file.source), candidate));
          if (source.startsWith("../") || posix.isAbsolute(source)) {
            throw new Error(
              `Vendor: declaration ${file.source} escapes ${declarationRoot}: ${specifier}`,
            );
          }
          try {
            if ((await stat(join(distDir, source))).isFile()) {
              resolved = source;
              break;
            }
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        if (resolved === undefined) {
          throw new Error(
            `Vendor: ${packageInfo.packageJson.name}'s declaration ${file.source} imports missing declaration ${specifier}`,
          );
        }
        if (!queued.has(resolved)) {
          queued.set(resolved, {
            source: resolved,
            output: posix.normalize(
              posix.join(
                posix.dirname(file.output),
                posix.relative(posix.dirname(file.source), resolved),
              ),
            ),
          });
        }
      }
    }
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

    if (extras.length > 0) {
      await Promise.all(
        extras
          .filter((file) => !/\.d\.[cm]?ts$/u.test(file))
          .map(async (file) => {
            const outputPath = join(destinationRoot, file);
            await mkdir(dirname(outputPath), { recursive: true });
            await copyFile(join(distDir, file), outputPath);
          }),
      );
    }
  };
}

function collectRelativeDeclarationReferences(source) {
  const file = ts.createSourceFile("declarations.d.ts", source, ts.ScriptTarget.Latest, true);
  const references = new Set(
    file.referencedFiles.map(({ fileName }) =>
      fileName.startsWith(".") ? fileName : `./${fileName}`,
    ),
  );
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      specifier = node.moduleReference.expression;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith("."))
      references.add(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return references;
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

export function collectExternalDeclarationImports(source) {
  const namedPattern = /^(?:import|export)\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];/gm;
  const namespacePattern =
    /^import\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];/gm;
  const sideEffectPattern = /^import\s+['"]([^'"]+)['"];/gm;
  const result = new Map();

  const isExternal = (moduleName) =>
    !moduleName.startsWith(".") &&
    !moduleName.startsWith("/") &&
    !moduleName.startsWith("#") &&
    !isBuiltin(moduleName);

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
    addName(moduleName);
    const memberPattern = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, "g");
    for (const memberMatch of source.matchAll(memberPattern)) {
      addName(moduleName, memberMatch[1]);
    }
  }

  for (const match of source.matchAll(sideEffectPattern)) {
    addName(match[1]);
  }

  const file = ts.createSourceFile("declarations.d.ts", source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      let qualifier = node.qualifier;
      while (qualifier && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      addName(node.argument.literal.text, qualifier?.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);

  return result;
}

export function rewriteImportSource(source, moduleName, replacement) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source
    .replaceAll(new RegExp(`from '${escaped}'`, "g"), `from '${replacement}'`)
    .replaceAll(new RegExp(`from "${escaped}"`, "g"), `from "${replacement}"`)
    .replaceAll(new RegExp(`import '${escaped}'`, "g"), `import '${replacement}'`)
    .replaceAll(new RegExp(`import "${escaped}"`, "g"), `import "${replacement}"`)
    .replaceAll(
      new RegExp(`import\\s*\\(\\s*(["'])${escaped}\\1\\s*\\)`, "g"),
      `import("${replacement}")`,
    );
}

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

export async function runVendor({
  packageRoot,
  compiledRoot,
  modules,
  scriptFiles,
  toolVersions = {},
}) {
  const stampPath = join(compiledRoot, ".vendor-stamp.json");
  const lockPath = join(compiledRoot, ".vendor-lock");

  await mkdir(compiledRoot, { recursive: true });

  const desiredStamp = await computeStamp({ scriptFiles, modules, packageRoot, toolVersions });

  if (
    stampMatches(desiredStamp, await readExistingStamp(stampPath)) &&
    (await compiledModuleEntrypointsExist({ compiledRoot, modules }))
  ) {
    console.log("Compiled vendor modules are already up to date.");
    return;
  }

  await acquireLock(lockPath);
  try {
    if (
      stampMatches(desiredStamp, await readExistingStamp(stampPath)) &&
      (await compiledModuleEntrypointsExist({ compiledRoot, modules }))
    ) {
      console.log("Compiled vendor modules are already up to date.");
      return;
    }

    await rm(stampPath, { force: true });

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

async function compiledModuleEntrypointsExist({ compiledRoot, modules }) {
  const paths = modules.flatMap((module) =>
    (module.entries ?? [{ outputPath: "index" }]).map((entry) =>
      join(compiledRoot, module.compiledPath, `${entry.outputPath}.js`),
    ),
  );
  const entries = await Promise.all(
    paths.map(async (path) => {
      const stats = await stat(path).catch(() => null);
      return stats?.isFile() ?? false;
    }),
  );
  return entries.every(Boolean);
}

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

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function findPackageJson(packageName, packageRoot, packageJsonName = packageName) {
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
      if (packageJson.name === packageJsonName) {
        return {
          packageJson,
          packageJsonPath,
          packageRoot: realpathSync(dirname(packageJsonPath)),
        };
      }
    }
    throw new Error(`Could not resolve "${packageName}".`);
  }

  while (currentPath !== parse(currentPath).root) {
    const packageJsonPath = join(currentPath, "package.json");
    if (await pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (packageJson.name === packageJsonName) {
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
  const packageInfo = await findPackageJson(
    module.packageName,
    packageRoot,
    module.packageJsonName,
  );

  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

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

function getModulePlatform(module) {
  return module.platform ?? "node";
}

function getDefaultResolve() {
  return { mainFields: ["module", "main"] };
}

async function bundleStandaloneModule({
  destinationRoot,
  module,
  packageInfo,
  packageRoot,
  sharedSpecifiers,
}) {
  const entries = getModuleEntries(module, packageInfo);
  const platform = getModulePlatform(module);

  if (entries.length !== 1 || entries[0]?.outputPath !== "index") {
    throw new Error(
      `Standalone vendored module "${module.packageName}" must emit one index entry.`,
    );
  }

  await buildWithRolldown({
    cwd: packageRoot,
    input: entries[0].input,
    external: module.external ?? [],
    moduleTypes: module.loader ?? {},
    platform,
    plugins: [
      ...(module.plugins ?? []),
      createSharedSpecifierPlugin(sharedSpecifiers, [module]),
      createRuntimeDependencyPlugin(packageRoot),
    ],
    resolve: module.resolve ?? getDefaultResolve(),
    treeshake: true,
    output: {
      banner: module.banner ?? "/* oxlint-disable */",
      codeSplitting: false,
      comments: false,
      file: join(destinationRoot, "index.js"),
      format: "esm",
      minify: true,
      sourcemap: false,
    },
    onLog: onVendoredDependencyLog,
  });
}

async function bundleModuleGroup({
  chunkGroup,
  platform,
  preparedModules,
  packageRoot,
  compiledRoot,
  sharedSpecifiers,
}) {
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
  const plugins = [
    ...preparedModules.flatMap(({ module }) => module.plugins ?? []),
    createSharedSpecifierPlugin(
      sharedSpecifiers,
      preparedModules.map(({ module }) => module),
    ),
    createRuntimeDependencyPlugin(packageRoot),
  ];

  await buildWithRolldown({
    cwd: packageRoot,
    input: entrypoints,
    external,
    moduleTypes,
    platform,
    plugins,
    resolve: getDefaultResolve(platform),
    treeshake: true,
    output: {
      banner: "/* oxlint-disable */",
      chunkFileNames: `_chunks/${chunkGroup}/[name]-[hash].js`,
      comments: false,
      dir: compiledRoot,
      entryFileNames: "[name].js",
      format: "esm",
      minify: chunkGroup === "client" ? { compress: { joinVars: false } } : true,
      sourcemap: false,
    },
    onLog: onVendoredDependencyLog,
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

  const sharedSpecifiers = collectSharedSpecifiers(preparedModules);
  const standalone = preparedModules.filter(({ module }) => module.bundling === "standalone");
  const shared = preparedModules.filter(({ module }) => module.bundling !== "standalone");
  const groups = Map.groupBy(
    shared,
    ({ module }) => `${module.chunkGroup ?? "node"}\0${getModulePlatform(module)}`,
  );

  await Promise.all(
    standalone.map((entry) => bundleStandaloneModule({ ...entry, packageRoot, sharedSpecifiers })),
  );

  await Promise.all(
    [...groups].map(([groupKey, groupModules]) => {
      const [chunkGroup, platform] = groupKey.split("\0");
      return bundleModuleGroup({
        chunkGroup,
        platform,
        preparedModules: groupModules,
        packageRoot,
        compiledRoot,
        sharedSpecifiers,
      });
    }),
  );

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

function collectSharedSpecifiers(preparedModules) {
  const shared = new Map();
  for (const { module, packageInfo } of preparedModules) {
    for (const [specifier, outputPath] of Object.entries(module.sharedSpecifiers ?? {})) {
      shared.set(specifier, {
        importSpecifier: `#compiled/${module.compiledPath}/${outputPath}.js`,
        module,
        packageRoot: realpathSync(packageInfo.packageRoot),
      });
    }
  }
  return shared;
}

function createRuntimeDependencyPlugin(packageRoot) {
  const installs = resolveInstalls(runtimeDependencyNames(packageRoot), packageRoot);
  return {
    name: "eve:vendored-runtime-dependencies",
    async resolveId(source, importer, options) {
      const install = installs.get(source);
      if (install === undefined || options.kind === "require-call") return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null || resolved.external || !isInsideDirectory(resolved.id, install)) {
        return null;
      }
      return { id: source, external: true };
    },
  };
}

function runtimeDependencyNames(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  return existsSync(manifestPath)
    ? Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).dependencies ?? {})
    : [];
}

function resolveInstalls(names, fromDir) {
  const resolveFrom = createRequire(join(fromDir, "package.json"));
  const installs = new Map();
  for (const name of names) {
    let dir;
    try {
      dir = dirname(resolveFrom.resolve(name));
    } catch {
      continue;
    }
    for (; dir !== parse(dir).root; dir = dirname(dir)) {
      const manifestPath = join(dir, "package.json");
      if (
        existsSync(manifestPath) &&
        JSON.parse(readFileSync(manifestPath, "utf8")).name === name
      ) {
        installs.set(name, realpathSync(dir));
        break;
      }
    }
  }
  return installs;
}

const SHARED_FACADE_PREFIX = "\0eve-shared-facade:";

function createSharedSpecifierPlugin(sharedSpecifiers, bundledModules) {
  const owners = new Map(
    [...sharedSpecifiers.values()].map((entry) => [entry.module.packageName, entry]),
  );
  const privateCopies = new Set(bundledModules.flatMap((module) => module.privateCopies ?? []));
  return {
    name: "eve:shared-vendored-modules",
    async resolveId(source, importer, options) {
      if (importer?.startsWith(SHARED_FACADE_PREFIX)) return { id: source, external: true };
      const owner = owners.get(packageNameOf(source));
      if (
        owner === undefined ||
        bundledModules.includes(owner.module) ||
        privateCopies.has(owner.module.packageName)
      ) {
        return null;
      }

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null || resolved.external) return null;
      if (!isInsideDirectory(resolved.id, owner.packageRoot)) {
        throw new Error(
          `Vendor: ${importer ?? "a vendored module"} resolves "${source}" to ${resolved.id}, a ` +
            `different install than the vendored "${owner.module.packageName}" at ` +
            `${owner.packageRoot}. eve ships a single copy of "${owner.module.packageName}"; align ` +
            `the dependency on one version (for example with a pnpm override). Only a different ` +
            `major whose objects never reach the shared copy may be listed in the vendored ` +
            `module's privateCopies.`,
        );
      }

      const target = sharedSpecifiers.get(source);
      if (target === undefined) {
        throw new Error(
          `Vendor: ${importer ?? "a vendored module"} imports "${source}", which the vendored ` +
            `"${owner.module.packageName}" module does not share. Add "${source}" to its ` +
            `sharedSpecifiers so eve keeps a single copy of "${owner.module.packageName}".`,
        );
      }
      if (options.kind === "require-call")
        return `${SHARED_FACADE_PREFIX}${target.importSpecifier}`;
      return { id: target.importSpecifier, external: true };
    },
    load(id) {
      if (!id.startsWith(SHARED_FACADE_PREFIX)) return null;
      return `export * from ${JSON.stringify(id.slice(SHARED_FACADE_PREFIX.length))};`;
    },
  };
}

function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":")) {
    return undefined;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function isInsideDirectory(file, directory) {
  let resolvedFile;
  try {
    resolvedFile = realpathSync(file);
  } catch {
    return false;
  }
  const offset = relative(directory, resolvedFile);
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
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

async function computeStamp({ scriptFiles, modules, packageRoot, toolVersions }) {
  const scriptHash = createHash("sha256");
  for (const file of [...scriptFiles].sort()) {
    const content = await readFile(file, "utf8");
    scriptHash.update(file);
    scriptHash.update("\0");
    scriptHash.update(content);
    scriptHash.update("\0");
  }

  const runtimeDependencies = runtimeDependencyNames(packageRoot);
  const eveInstalls = resolveInstalls(runtimeDependencies, packageRoot);
  const unsharedRuntimeDependencies = [];

  const moduleFingerprints = {};
  const moduleVersions = {};
  for (const module of modules) {
    const packageInfo = await findPackageJson(
      module.packageName,
      packageRoot,
      module.packageJsonName,
    );
    moduleVersions[module.packageName] = packageInfo.packageJson.version ?? "0.0.0";
    const moduleInstalls = resolveInstalls(runtimeDependencies, packageInfo.packageRoot);
    for (const [name, install] of eveInstalls) {
      if (moduleInstalls.get(name) !== install) {
        unsharedRuntimeDependencies.push(`${module.packageName}>${name}`);
      }
    }

    if (module.fingerprintFiles !== undefined) {
      const moduleHash = createHash("sha256");
      for (const file of [...module.fingerprintFiles].sort()) {
        const content = await readFile(join(packageInfo.packageRoot, file), "utf8");
        moduleHash.update(file);
        moduleHash.update("\0");
        moduleHash.update(content);
        moduleHash.update("\0");
      }
      moduleFingerprints[module.packageName] = moduleHash.digest("hex");
    }
  }

  return {
    moduleFingerprints,
    moduleVersions,
    scriptHash: scriptHash.digest("hex"),
    toolVersions: Object.fromEntries(
      Object.entries(toolVersions).sort(([a], [b]) => a.localeCompare(b)),
    ),
    unsharedRuntimeDependencies,
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

export async function acquireLock(lockPath, timeoutMs = 120_000) {
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

export async function releaseLock(lockPath) {
  await rm(lockPath, { recursive: true, force: true });
}
