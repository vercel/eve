import { cp, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { EXTENSION_COMPATIBILITY_MANIFEST_FILENAME } from "#compiler/extension-compatibility.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  bundleExtensionDistributionGraph,
  type ExtensionDistributionGraphEntry,
} from "#internal/authored-module-loader.js";
import { emitExtensionDeclarations } from "#internal/nitro/host/extension-declarations.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/** Emits the runnable, agent-shaped tree and its package entrypoints into staging. */
export async function emitExtensionDistribution(input: {
  readonly appRoot: string;
  readonly declarationModule: ModuleSourceRef;
  readonly declarationsRoot: string;
  readonly manifest: AgentSourceManifest;
  readonly runtimeDependencies: readonly string[];
  readonly shortName: string;
  readonly sourceRoot: string;
  readonly stagedDistRoot: string;
  readonly stagedOutDir: string;
  readonly transactionRoot: string;
}): Promise<void> {
  const sourceFiles = await collectExtensionSourceFiles(input.sourceRoot);
  const skillPackageRoots = input.manifest.skills
    .filter((skill) => skill.sourceKind === "skill-package")
    .map((skill) => relative(input.sourceRoot, skill.rootPath).replaceAll("\\", "/"));
  const moduleFiles = sourceFiles.filter(
    (file) =>
      isAuthoredModule(file.logicalPath) &&
      !skillPackageRoots.some((root) => file.logicalPath.startsWith(`${root}/`)),
  );
  await copyDistributionDataFiles({
    files: sourceFiles,
    moduleLogicalPaths: new Set(moduleFiles.map((file) => file.logicalPath)),
    stagedDistRoot: input.stagedDistRoot,
  });
  const entries = await createDistributionEntries({ ...input, moduleFiles });
  const emitted = await bundleExtensionDistributionGraph({
    entries,
    packageRoot: input.appRoot,
    runtimeDependencies: input.runtimeDependencies,
  });
  for (const [fileName, code] of emitted) {
    const outputPath = join(input.stagedOutDir, fileName);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, code, "utf8");
  }

  await emitExtensionDeclarations({
    appRoot: input.appRoot,
    declarationsRoot: input.declarationsRoot,
    moduleLogicalPaths: moduleFiles.map((file) => file.logicalPath),
    sourceRoot: input.sourceRoot,
  });
  const sourceRelativePath = relative(input.appRoot, input.sourceRoot);
  try {
    await cp(join(input.declarationsRoot, sourceRelativePath), input.stagedDistRoot, {
      recursive: true,
    });
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    throw new Error(
      `TypeScript emitted no declarations for "${sourceRelativePath}". Ensure the package tsconfig.json \`include\` covers every module under \`eve.extension.source\`.`,
      { cause: error },
    );
  }
  await emitDeclarationBarrels(input);
}

/**
 * Thrown when publishing failed and the prior output could not be moved back.
 * The prior output survives at {@link preservedOutputPath}; callers must not
 * delete the transaction directory that contains it.
 */
export class ExtensionOutputRestoreError extends Error {
  readonly preservedOutputPath: string;

  constructor(preservedOutputPath: string, options: { cause: unknown }) {
    super(
      `Publishing the extension build output failed, and the previous output could not be restored. It is preserved at "${preservedOutputPath}".`,
      options,
    );
    this.name = "ExtensionOutputRestoreError";
    this.preservedOutputPath = preservedOutputPath;
  }
}

/** Atomically publishes a staged extension output, restoring the prior tree on failure. */
export async function replaceExtensionBuildOutput(input: {
  readonly outDir: string;
  readonly stagedOutDir: string;
  readonly transactionRoot: string;
}): Promise<void> {
  await mkdir(dirname(input.outDir), { recursive: true });
  const previousOutDir = join(input.transactionRoot, "previous-output");
  let hadPreviousOutput = false;
  try {
    await rename(input.outDir, previousOutDir);
    hadPreviousOutput = true;
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  try {
    await rename(input.stagedOutDir, input.outDir);
  } catch (error) {
    if (hadPreviousOutput) {
      try {
        await rename(previousOutDir, input.outDir);
      } catch {
        throw new ExtensionOutputRestoreError(previousOutDir, { cause: error });
      }
    }
    throw error;
  }
}

interface ExtensionSourceFile {
  readonly absolutePath: string;
  readonly logicalPath: string;
}

async function collectExtensionSourceFiles(
  sourceRoot: string,
  directory = sourceRoot,
): Promise<ExtensionSourceFile[]> {
  const files: ExtensionSourceFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectExtensionSourceFiles(sourceRoot, absolutePath)));
    } else if (entry.isFile()) {
      const logicalPath = relative(sourceRoot, absolutePath).replaceAll("\\", "/");
      if (logicalPath === EXTENSION_COMPATIBILITY_MANIFEST_FILENAME) {
        throw new Error(
          `The extension source cannot contain "${EXTENSION_COMPATIBILITY_MANIFEST_FILENAME}"; eve reserves it for generated compatibility metadata.`,
        );
      }
      files.push({ absolutePath, logicalPath });
    } else {
      throw new Error(
        `Extension source entry "${absolutePath}" must be a regular file or directory.`,
      );
    }
  }
  return files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function isAuthoredModule(logicalPath: string): boolean {
  return (
    !/\.d\.[cm]?ts$/.test(logicalPath) &&
    SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS.some((extension) => logicalPath.endsWith(extension))
  );
}

async function copyDistributionDataFiles(input: {
  readonly files: readonly ExtensionSourceFile[];
  readonly moduleLogicalPaths: ReadonlySet<string>;
  readonly stagedDistRoot: string;
}): Promise<void> {
  await Promise.all(
    input.files
      .filter((file) => !input.moduleLogicalPaths.has(file.logicalPath))
      .map(async (file) => {
        const outputPath = join(input.stagedDistRoot, file.logicalPath);
        await mkdir(dirname(outputPath), { recursive: true });
        await cp(file.absolutePath, outputPath);
      }),
  );
}

async function createDistributionEntries(input: {
  readonly declarationModule: ModuleSourceRef;
  readonly manifest: AgentSourceManifest;
  readonly moduleFiles: readonly ExtensionSourceFile[];
  readonly shortName: string;
  readonly sourceRoot: string;
  readonly stagedDistRoot: string;
  readonly stagedOutDir: string;
  readonly transactionRoot: string;
}): Promise<ExtensionDistributionGraphEntry[]> {
  const outputPrefix = relative(input.stagedOutDir, input.stagedDistRoot).replaceAll("\\", "/");
  const entries = input.moduleFiles.map((file) => ({
    name: `${outputPrefix}/${stripAuthoredModuleExtension(file.logicalPath)}`,
    path: file.absolutePath,
  }));
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new Error(`Multiple extension modules emit the same path "${entry.name}.mjs".`);
    }
    names.add(entry.name);
  }

  const barrelRoot = join(input.transactionRoot, "barrels");
  entries.push(
    await stageRuntimeBarrel({
      barrelPath: join(barrelRoot, "index.mjs"),
      name: "index",
      reexports: [
        { name: "default", path: join(input.sourceRoot, input.declarationModule.logicalPath) },
        {
          name: input.shortName,
          path: join(input.sourceRoot, input.declarationModule.logicalPath),
        },
      ],
    }),
    await stageRuntimeBarrel({
      barrelPath: join(barrelRoot, "tools.mjs"),
      name: "tools/index",
      reexports: input.manifest.tools.map((tool) => ({
        name: toolExportName(tool.logicalPath),
        path: join(input.sourceRoot, tool.logicalPath),
      })),
    }),
  );
  return entries;
}

async function stageRuntimeBarrel(input: {
  readonly barrelPath: string;
  readonly name: string;
  readonly reexports: readonly { readonly name: string; readonly path: string }[];
}): Promise<ExtensionDistributionGraphEntry> {
  await mkdir(dirname(input.barrelPath), { recursive: true });
  const lines = input.reexports.map((reexport) =>
    reexportLine(reexport.name, relativeImport(dirname(input.barrelPath), reexport.path)),
  );
  await writeFile(input.barrelPath, `${lines.join("\n")}\n`, "utf8");
  return { name: input.name, path: input.barrelPath };
}

async function emitDeclarationBarrels(input: {
  readonly declarationModule: ModuleSourceRef;
  readonly manifest: AgentSourceManifest;
  readonly shortName: string;
  readonly stagedDistRoot: string;
  readonly stagedOutDir: string;
}): Promise<void> {
  await mkdir(join(input.stagedOutDir, "tools"), { recursive: true });
  const declarationSpecifier = relativeImport(
    input.stagedOutDir,
    join(input.stagedDistRoot, input.declarationModule.logicalPath),
  );
  await writeDeclarationBarrel({
    path: join(input.stagedOutDir, "index.d.ts"),
    reexports: [
      { name: "default", specifier: declarationSpecifier },
      { name: input.shortName, specifier: declarationSpecifier },
    ],
  });
  await writeDeclarationBarrel({
    path: join(input.stagedOutDir, "tools", "index.d.ts"),
    reexports: input.manifest.tools.map((tool) => ({
      name: toolExportName(tool.logicalPath),
      specifier: relativeImport(
        join(input.stagedOutDir, "tools"),
        join(input.stagedDistRoot, tool.logicalPath),
      ),
    })),
  });
}

async function writeDeclarationBarrel(input: {
  readonly path: string;
  readonly reexports: readonly { readonly name: string; readonly specifier: string }[];
}): Promise<void> {
  const lines = input.reexports.map((reexport) =>
    reexportLine(reexport.name, toDeclarationSpecifier(reexport.specifier)),
  );
  await writeFile(
    input.path,
    ["// Generated by eve. Do not edit by hand.", "", ...lines, ""].join("\n"),
    "utf8",
  );
}

function stripAuthoredModuleExtension(logicalPath: string): string {
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (logicalPath.endsWith(extension)) {
      return logicalPath.slice(0, logicalPath.length - extension.length);
    }
  }
  return logicalPath;
}

function toolExportName(logicalPath: string): string {
  const name = stripAuthoredModuleExtension(logicalPath).replace(/^tools\//, "");
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function relativeImport(fromDir: string, targetPath: string): string {
  const rel = relative(fromDir, targetPath).replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function reexportLine(name: string, specifier: string): string {
  return name === "default"
    ? `export { default } from ${JSON.stringify(specifier)};`
    : `export { default as ${name} } from ${JSON.stringify(specifier)};`;
}

function toDeclarationSpecifier(specifier: string): string {
  return specifier
    .replace(/\.mts$/, ".mjs")
    .replace(/\.cts$/, ".cjs")
    .replace(/\.tsx?$/, ".js");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
