import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAuthoredAssetImportPlugin } from "#internal/authored-asset-import-plugin.js";
import {
  resolvePackageRoot,
  resolveWorkflowModulePath,
  WORKFLOW_MODULE_SPECIFIERS,
} from "#internal/application/package.js";
import { createExtensionMountPlugin } from "#internal/bundler/extension-mount-plugin.js";
import { createExtensionScopePlugin } from "#internal/bundler/extension-scope-plugin.js";
import { createPseudoPackagePlugin } from "#internal/bundler/pseudo-packages.js";
import type { CompiledExtensionMount } from "#compiler/manifest.js";
import { createCompiledSandboxProviderPrunePlugin } from "#internal/nitro/host/compiled-sandbox-provider-prune-plugin.js";
import { createDevelopmentRuntimePrunePlugin } from "#internal/nitro/host/development-runtime-prune-plugin.js";
import { createExtensionExternalDependencyPlugin } from "#internal/nitro/host/extension-external-dependency-plugin.js";
import { createExternalDependencyOutputCheckPlugin } from "#internal/nitro/host/external-dependency-output-check-plugin.js";
import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { createNitroRoutingImportSpecifierPlugin } from "#internal/nitro/host/nitro-routing-import-specifier-plugin.js";
import { createOptionalEngineDependencyPlugin } from "#internal/nitro/host/optional-engine-dependency-plugin.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";
import type { WorkflowArtifacts } from "#internal/workflow-bundle/builder.js";
import type { NitroConfig } from "nitro/types";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";

/** Rolldown plugins as Nitro's config accepts them. */
export type HostBuildPlugins = NonNullable<NonNullable<NitroConfig["rolldownConfig"]>["plugins"]>;

export interface HostPluginsInput {
  readonly appRoot: string;
  /** Package root authored assets may not escape. */
  readonly authoredPackageRoot: string;
  readonly externals: ExternalsPolicy;
  readonly extensionMounts: readonly CompiledExtensionMount[];
  readonly extensionOverridePaths: ReadonlyMap<string, string>;
  readonly instrumentationEntryPlugin?: HostBuildPlugins;
  readonly instrumentationSourcePaths?: readonly string[];
  readonly workflowArtifacts: WorkflowArtifacts;
  readonly workflowBuildDir: string;
}

/**
 * eve's host build plugins in the order they must run, ahead of Nitro's own.
 * Step transforms and side-effect resolution come first so extension-mount
 * resolution never claims a workflow module.
 */
export function createHostPlugins(input: HostPluginsInput): HostBuildPlugins {
  const stepTargets = new Set(
    input.workflowArtifacts.stepTargets.map(normalizeStepTransformComparisonPath),
  );
  const { externals } = input;
  return [
    createStepTransformPlugin(input.appRoot, stepTargets),
    createStepModuleSideEffectsPlugin(input.appRoot, stepTargets),
    input.instrumentationSourcePaths === undefined
      ? null
      : createInstrumentationModuleSideEffectsPlugin(input.instrumentationSourcePaths),
    createWorkflowModuleSideEffectsPlugin(input.appRoot, input.workflowBuildDir),
    createNitroRoutingImportSpecifierPlugin(),
    input.instrumentationEntryPlugin ?? null,
    createNodeEsmCompatBannerPlugin(),
    // Before Nitro's externals and tracing, so a pseudo-package never reaches
    // the output as a live import.
    createPseudoPackagePlugin(),
    externals.pruneDevelopmentRuntime ? createDevelopmentRuntimePrunePlugin() : null,
    externals.pruneSandboxProviders ? createCompiledSandboxProviderPrunePlugin() : null,
    createOptionalEngineDependencyPlugin(externals.untracedExternals),
    createExtensionExternalDependencyPlugin(input.extensionMounts),
    createExternalDependencyOutputCheckPlugin({
      appRoot: input.appRoot,
      externalDependencies: externals.checkedExternals,
    }),
    createExtensionMountPlugin(input.extensionMounts, input.extensionOverridePaths),
    createExtensionScopePlugin(
      input.extensionMounts.map((mount) => ({
        mountId: mount.mountId,
        sourceRoot: mount.sourceRoot,
      })),
    ),
    // Workflow step modules reach Nitro as authored source, not prebundled.
    createAuthoredAssetImportPlugin({
      authoredSourceOnly: true,
      packageRoot: input.authoredPackageRoot,
    }),
  ].filter((plugin) => plugin !== null);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function stripPathQueryAndHash(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const cutoff =
    queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);

  return cutoff === -1 ? path : path.slice(0, cutoff);
}

function resolveNitroModuleComparisonPath(rootDir: string, path: string): string {
  if (path.startsWith("file://")) {
    return normalizePath(stripPathQueryAndHash(fileURLToPath(path)));
  }

  if (isAbsolute(path)) {
    return normalizePath(stripPathQueryAndHash(path));
  }

  return normalizePath(stripPathQueryAndHash(resolve(rootDir, path)));
}

function normalizeStepTransformComparisonPath(path: string): string {
  const normalizedPath = normalizePath(path);
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function resolveNitroImportPath(
  rootDir: string,
  importSpecifier: string,
  importer?: string,
): string | null {
  if (WORKFLOW_MODULE_SPECIFIERS.includes(importSpecifier)) {
    return resolveWorkflowModulePath(importSpecifier);
  }

  if (
    importSpecifier.startsWith(".") ||
    importSpecifier.startsWith("/") ||
    importSpecifier.startsWith("file://")
  ) {
    const importerDirectory =
      importer === undefined
        ? rootDir
        : dirname(resolveNitroModuleComparisonPath(rootDir, importer));

    return resolveNitroModuleComparisonPath(importerDirectory, importSpecifier);
  }

  return null;
}

function createRelativeTransformFilename(workingDir: string, path: string): string {
  const packageRelativePath = createPackageRelativeTransformFilename(path);
  if (packageRelativePath !== undefined) {
    return packageRelativePath;
  }

  const normalizedWorkingDir = normalizePath(workingDir).replace(/\/$/, "");
  const normalizedPath = normalizePath(path);
  const lowerWorkingDir = normalizedWorkingDir.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();

  if (lowerPath.startsWith(`${lowerWorkingDir}/`)) {
    return normalizedPath.slice(normalizedWorkingDir.length + 1);
  }

  if (lowerPath === lowerWorkingDir) {
    return ".";
  }

  let relativePath = relative(normalizedWorkingDir, normalizedPath).replaceAll("\\", "/");

  if (relativePath.startsWith("../")) {
    relativePath = relativePath
      .split("/")
      .filter((part) => part !== "..")
      .join("/");
  }

  if (relativePath.includes(":") || relativePath.startsWith("/")) {
    const filename = normalizedPath.split("/").pop();
    return filename === undefined || filename.length === 0 ? "unknown.ts" : filename;
  }

  return relativePath;
}

function createPackageRelativeTransformFilename(path: string): string | undefined {
  const normalizedPackageRoot = normalizePath(resolvePackageRoot()).replace(/\/$/, "");
  const normalizedPath = normalizePath(path);
  const lowerPackageRoot = normalizedPackageRoot.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  const packageSourcePrefix = `${normalizedPackageRoot}/src/`;
  const lowerPackageSourcePrefix = `${lowerPackageRoot}/src/`;
  const packageDistSourcePrefix = `${normalizedPackageRoot}/dist/src/`;
  const lowerPackageDistSourcePrefix = `${lowerPackageRoot}/dist/src/`;

  if (lowerPath.startsWith(lowerPackageSourcePrefix)) {
    return `src/${normalizedPath.slice(packageSourcePrefix.length)}`;
  }

  if (lowerPath.startsWith(lowerPackageDistSourcePrefix)) {
    return `src/${normalizedPath.slice(packageDistSourcePrefix.length)}`;
  }

  return undefined;
}

function createWorkflowModuleSideEffectsPlugin(rootDir: string, workflowBuildDir: string) {
  const workflowBundleDirectory = resolveNitroModuleComparisonPath(rootDir, workflowBuildDir);
  return {
    name: "eve:workflow-module-side-effects",
    resolveId(source: string, importer: string | undefined) {
      const resolvedSource =
        resolveNitroImportPath(rootDir, source, importer) ??
        resolveNitroModuleComparisonPath(rootDir, source);

      if (!resolvedSource.startsWith(workflowBundleDirectory)) {
        return null;
      }

      return {
        id: resolvedSource,
        moduleSideEffects: "no-treeshake" as const,
      };
    },
  };
}

function createStepModuleSideEffectsPlugin(rootDir: string, stepTargets: ReadonlySet<string>) {
  return {
    name: "eve:workflow-step-module-side-effects",
    resolveId(source: string, importer?: string) {
      const resolvedSource = resolveNitroImportPath(rootDir, source, importer);

      if (resolvedSource === null) {
        return null;
      }

      if (!stepTargets.has(normalizeStepTransformComparisonPath(resolvedSource))) {
        return null;
      }

      return {
        id: resolvedSource,
        moduleSideEffects: "no-treeshake" as const,
      };
    },
  };
}

/**
 * Transforms package-owned execution sources in step mode so the generated
 * `steps.mjs` entry can import raw source files while still registering
 * durable step handlers with the Workflow runtime.
 */
function createStepTransformPlugin(rootDir: string, stepTargets: ReadonlySet<string>) {
  return {
    async transform(code: string, id: string) {
      const resolvedId = resolveNitroModuleComparisonPath(rootDir, id);

      if (!stepTargets.has(normalizeStepTransformComparisonPath(resolvedId))) {
        return null;
      }

      const result = await applyWorkflowTransform(
        createRelativeTransformFilename(rootDir, resolvedId),
        code,
        "step",
        resolvedId,
        rootDir,
      );

      return {
        code: result.code,
        map: null,
      };
    },
    name: "eve:workflow-step-transform",
  };
}

/**
 * Marks the authored instrumentation modules as side-effectful so the final
 * bundle preserves their eager evaluation from the generated instrumentation
 * plugin.
 */
function createInstrumentationModuleSideEffectsPlugin(
  instrumentationModulePaths: readonly string[],
) {
  const normalizedInstrumentationModulePaths = new Set(
    instrumentationModulePaths.map(normalizePath),
  );
  return {
    name: "eve:instrumentation-module-side-effects",
    resolveId(source: string) {
      if (!normalizedInstrumentationModulePaths.has(normalizePath(source))) {
        return null;
      }

      return {
        id: source,
        moduleSideEffects: "no-treeshake" as const,
      };
    },
  };
}
