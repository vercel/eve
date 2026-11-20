import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  EXTENSION_COMPATIBILITY_MANIFEST_KIND,
  EXTENSION_DISTRIBUTION_CONTRACT_MAJOR,
  writeExtensionCompatibilityManifest,
} from "#compiler/extension-compatibility.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { discoverFlatModuleSource, readSortedDirectoryEntries } from "#discover/grammar.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  ensureExtensionExports,
  tryReadExtensionBuildConfig,
  type ExtensionBuildConfig,
} from "#internal/nitro/host/extension-build-config.js";
import {
  emitExtensionDistribution,
  ExtensionOutputRestoreError,
  replaceExtensionBuildOutput,
} from "#internal/nitro/host/extension-distribution.js";

export { tryReadExtensionBuildConfig };
export type { ExtensionBuildConfig };

export const EXTENSION_BUILD_STAGING_DIRECTORY_PREFIX = ".eve-extension-build-";

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

  const declarationModule = discoverFlatModuleSource({
    rootEntries: await readSortedDirectoryEntries(source, config.sourceRoot),
    rootPath: config.sourceRoot,
    slotName: "extension",
  }).module;
  if (declarationModule === undefined) {
    throw new Error(
      `Cannot build extension "${config.packageName}": its source root "${config.sourceRoot}" is missing an "extension.<ext>" declaration. Add \`export default defineExtension(...)\` there (with or without config).`,
    );
  }

  const transactionRoot = await mkdtemp(join(appRoot, EXTENSION_BUILD_STAGING_DIRECTORY_PREFIX));
  const stagedOutDir = join(transactionRoot, "output");
  const stagedDistRoot = join(stagedOutDir, relative(config.outDir, config.distRoot));
  let preserveTransactionRoot = false;
  try {
    await mkdir(stagedDistRoot, { recursive: true });
    await emitExtensionDistribution({
      appRoot,
      declarationModule,
      declarationsRoot: join(transactionRoot, "declarations"),
      manifest,
      runtimeDependencies: config.runtimeDependencies,
      shortName: config.shortName,
      sourceRoot: config.sourceRoot,
      stagedDistRoot,
      stagedOutDir,
      transactionRoot,
    });
    await ensureExtensionExports(appRoot, config.outDir);
    await writeExtensionCompatibilityManifest(stagedDistRoot, {
      kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
      formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
      builtWithEve: resolveInstalledPackageInfo().version,
      contractMajor: EXTENSION_DISTRIBUTION_CONTRACT_MAJOR,
      ...(config.externalDependencies.length === 0
        ? {}
        : { build: { externalDependencies: config.externalDependencies } }),
    });
    await replaceExtensionBuildOutput({ outDir: config.outDir, stagedOutDir, transactionRoot });
    return config.outDir;
  } catch (error) {
    preserveTransactionRoot = error instanceof ExtensionOutputRestoreError;
    throw error;
  } finally {
    if (!preserveTransactionRoot) {
      await rm(transactionRoot, { force: true, recursive: true });
    }
  }
}
