import { posix, relative, win32 } from "node:path";
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
import { exactRegex, pathsRegex } from "#internal/bundler/filters.js";
import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { createHostedGraphPlugin } from "#internal/nitro/host/hosted-graph-plugin.js";
import { workflowHandlerPath } from "#internal/nitro/host/host-routes.js";
import { createNitroRoutingImportSpecifierPlugin } from "#internal/nitro/host/nitro-routing-import-specifier-plugin.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";
import type { WorkflowArtifacts } from "#internal/workflow-bundle/builder.js";
import type { NitroConfig } from "nitro/types";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";

/** Rolldown plugins as Nitro's config accepts them. */
type HostBuildPlugins = NonNullable<NonNullable<NitroConfig["rolldownConfig"]>["plugins"]>;

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
}

/**
 * eve's host build plugins in the order they must run, ahead of Nitro's own.
 * Step transforms and side-effect resolution come first so extension-mount
 * resolution never claims a workflow module.
 */
export function createHostPlugins(input: HostPluginsInput): HostBuildPlugins {
  const { stepTargets, stepsPath, workflowsPath } = input.workflowArtifacts;
  return [
    stepTargets.length === 0 ? null : createStepTransformPlugin(input.appRoot, stepTargets),
    createSideEffectModulesPlugin(input.appRoot, [
      ...stepTargets,
      stepsPath,
      workflowsPath,
      workflowHandlerPath(input.workflowArtifacts),
      ...(input.instrumentationSourcePaths ?? []),
    ]),
    createNitroRoutingImportSpecifierPlugin(),
    input.instrumentationEntryPlugin ?? null,
    createNodeEsmCompatBannerPlugin(),
    // Before Nitro's externals and tracing, so a pseudo-package never reaches
    // the output as a live import.
    createPseudoPackagePlugin(),
    createHostedGraphPlugin({ appRoot: input.appRoot, externals: input.externals }),
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

export interface ModulePathMatcher {
  /**
   * Matches a module specifier or id against the paths as the platform's
   * filesystem does: specifiers resolve against their importer, drive-less
   * absolute paths take the current drive on Windows, separators are compared
   * as `/`, and Windows compares case-insensitively. Returns the matched path
   * with `/` separators, or null.
   */
  readonly match: (specifier: string, importer?: string) => string | null;
  /**
   * A Rolldown id filter that admits every path `match` accepts, as given or
   * as `match` resolves it. A plugin that resolves a path to that form hands
   * later hooks the resolved id.
   */
  readonly idFilter: RegExp;
}

export function createModulePathMatcher(
  rootDir: string,
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ModulePathMatcher {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const toPath = (directory: string, specifier: string) =>
    normalizePath(
      path.resolve(
        directory,
        specifier.startsWith("file://")
          ? fileURLToPath(specifier, { windows })
          : stripPathQueryAndHash(specifier),
      ),
    );
  const toKey = (resolved: string) => (windows ? resolved.toLowerCase() : resolved);
  const targets = paths.map((target) => toPath(rootDir, target));
  const keys = new Set(targets.map(toKey));

  const match = (specifier: string, importer?: string) => {
    let resolved: string;
    if (WORKFLOW_MODULE_SPECIFIERS.includes(specifier)) {
      resolved = toPath(rootDir, resolveWorkflowModulePath(specifier));
    } else if (
      specifier.startsWith(".") ||
      specifier.startsWith("file://") ||
      path.isAbsolute(specifier)
    ) {
      const directory = importer === undefined ? rootDir : path.dirname(toPath(rootDir, importer));
      resolved = toPath(directory, specifier);
    } else {
      return null;
    }
    return keys.has(toKey(resolved)) ? resolved : null;
  };
  return { idFilter: pathsRegex([...new Set([...paths, ...targets])], platform), match };
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

// The specifiers createModulePathMatcher resolves; anything else cannot name a side-effect module.
const SIDE_EFFECT_SPECIFIER_FILTER = [
  /^(?:\.|\/|\\|[A-Za-z]:[\\/]|file:\/\/)/,
  ...WORKFLOW_MODULE_SPECIFIERS.map((specifier) => exactRegex(specifier)),
];

/**
 * Keeps modules evaluated for their side effects: the workflow bundle and its
 * handler, step modules that register durable steps, and instrumentation
 * modules the generated instrumentation plugin imports eagerly.
 */
function createSideEffectModulesPlugin(rootDir: string, paths: readonly string[]) {
  const { match } = createModulePathMatcher(rootDir, paths);
  return {
    name: "eve:side-effect-modules",
    resolveId: {
      filter: { id: SIDE_EFFECT_SPECIFIER_FILTER },
      handler(source: string, importer: string | undefined) {
        const id = match(source, importer);
        return id === null ? null : { id, moduleSideEffects: "no-treeshake" as const };
      },
    },
  };
}

/**
 * Transforms package-owned execution sources in step mode so the generated
 * `steps.mjs` entry can import raw source files while still registering
 * durable step handlers with the Workflow runtime.
 */
function createStepTransformPlugin(rootDir: string, stepTargets: readonly string[]) {
  // Step targets are also side-effect modules, so a transform sees the id
  // the side-effect plugin resolved them to.
  const { idFilter, match } = createModulePathMatcher(rootDir, stepTargets);
  return {
    name: "eve:workflow-step-transform",
    transform: {
      filter: { id: idFilter },
      async handler(code: string, id: string) {
        const resolvedId = match(id);
        if (resolvedId === null) return null;
        const result = await applyWorkflowTransform(
          createRelativeTransformFilename(rootDir, resolvedId),
          code,
          "step",
          resolvedId,
          rootDir,
        );
        return { code: result.code, map: null };
      },
    },
  };
}
