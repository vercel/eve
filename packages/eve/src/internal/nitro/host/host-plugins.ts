import { posix, relative, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolvePackageCompiledFilePath,
  resolvePackageRoot,
  resolveWorkflowModulePath,
  WORKFLOW_MODULE_SPECIFIERS,
} from "#internal/application/package.js";
import { createAuthoredPlugins } from "#internal/bundler/authored-plugins.js";
import {
  createExtensionMountPlugin,
  parseExtensionMountId,
  resolveExtensionMountForId,
  tagExtensionMountId,
} from "#internal/bundler/extension-mount-plugin.js";
import { createExtensionScopePlugin } from "#internal/bundler/extension-scope-plugin.js";
import { createPseudoPackagePlugin } from "#internal/bundler/pseudo-packages.js";
import type { CompiledExtensionMount } from "#compiler/manifest.js";
import { escapeRegex, exactRegex, pathsRegex } from "#internal/bundler/filters.js";
import { isPathInsideOrEqual } from "#shared/path-inside.js";
import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { createHostedGraphPlugin } from "#internal/nitro/host/hosted-graph-plugin.js";
import { workflowHandlerPath } from "#internal/nitro/host/host-routes.js";
import type { WorkflowArtifacts } from "#internal/workflow-bundle/builder.js";
import type { NitroBuildPlugin } from "nitro/types";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";

export interface HostPluginsInput {
  readonly appRoot: string;
  readonly loadVendoredDependenciesNatively?: boolean;
  readonly authoredPackageRoot: string;
  readonly externals: ExternalsPolicy;
  readonly extensionMounts: readonly CompiledExtensionMount[];
  readonly extensionOverridePaths: ReadonlyMap<string, string>;
  readonly instrumentationEntryPlugin?: NitroBuildPlugin;
  readonly instrumentationSourcePaths?: readonly string[];
  readonly hostBundledPackageRoots?: readonly string[];
  readonly runtimeModules: readonly string[];
  readonly workflowArtifacts: WorkflowArtifacts;
}

export function createHostPlugins(input: HostPluginsInput): NitroBuildPlugin[] {
  const { stepTargets, stepsPath, workflowsPath } = input.workflowArtifacts;
  const plugins: (NitroBuildPlugin | null)[] = [
    input.loadVendoredDependenciesNatively === true
      ? createDevelopmentCompiledExternalsPlugin()
      : null,
    stepTargets.length === 0
      ? null
      : createStepTransformPlugin(input.appRoot, stepTargets, input.extensionMounts),
    createSideEffectModulesPlugin(input.appRoot, [
      ...stepTargets,
      stepsPath,
      workflowsPath,
      workflowHandlerPath(input.workflowArtifacts),
      ...(input.instrumentationSourcePaths ?? []),
      ...input.runtimeModules,
    ]),
    input.instrumentationEntryPlugin ?? null,
    createPseudoPackagePlugin(),
    createHostedGraphPlugin({ appRoot: input.appRoot, externals: input.externals }),
    createExtensionMountPlugin(input.extensionMounts, input.extensionOverridePaths, {
      bindHandles: true,
    }),
    createExtensionScopePlugin(
      input.extensionMounts.map((mount) => ({
        mountId: mount.mountId,
        sourceRoot: mount.sourceRoot,
      })),
    ),
    ...createAuthoredPlugins({
      authoredSourceOnly: true,
      hostBundledPackageRoots: input.hostBundledPackageRoots,
      packageRoot: input.authoredPackageRoot,
    }),
  ];
  return plugins
    .filter((plugin) => plugin !== null)
    .map((plugin) => ({ ...plugin, enforce: "pre" as const }));
}

function createDevelopmentCompiledExternalsPlugin(): NitroBuildPlugin {
  const packageRoot = resolvePackageRoot();
  return {
    name: "eve:development-compiled-externals",
    resolveId: {
      filter: { id: /^#compiled\// },
      handler(source, importer) {
        const path = importer?.replace(/\?.*$/su, "");
        if (
          path === undefined ||
          !isPathInsideOrEqual(path, packageRoot) ||
          relative(packageRoot, path).split(/[\\/]/u).includes("node_modules")
        ) {
          return null;
        }
        return {
          external: true,
          id: pathToFileURL(resolvePackageCompiledFilePath(`src/${source.slice(1)}`)).href,
        };
      },
    },
  };
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
  readonly match: (specifier: string, importer?: string) => string | null;
  readonly idFilter: RegExp;
  readonly specifierFilter: RegExp[];
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
  const basenames = new Set(targets.map((target) => target.slice(target.lastIndexOf("/") + 1)));
  const pathSpecifier = new RegExp(
    `^(?=\\.|[\\\\/]|[A-Za-z]:[\\\\/])(?:[^?#]*[\\\\/])?(?:${[...basenames].map(escapeRegex).join("|")}|\\.{0,2})(?:[?#].*)?$`,
    windows ? "i" : undefined,
  );
  return {
    idFilter: pathsRegex(
      [...new Set([...paths.map((target) => stripPathQueryAndHash(target)), ...targets])],
      platform,
    ),
    match,
    specifierFilter: [
      pathSpecifier,
      /^file:\/\//,
      ...WORKFLOW_MODULE_SPECIFIERS.map((specifier) => exactRegex(specifier)),
    ],
  };
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

function createSideEffectModulesPlugin(rootDir: string, paths: readonly string[]) {
  const { match, specifierFilter } = createModulePathMatcher(rootDir, paths);
  const windows = process.platform === "win32";
  const toKey = (resolved: string, mountId: string | undefined) =>
    `${windows ? resolved.toLowerCase() : resolved}\0${mountId ?? ""}`;
  const targetKeys = new Set(
    paths.flatMap((path) => {
      const resolved = match(path);
      return resolved === null ? [] : [toKey(resolved, parseExtensionMountId(path).mountId)];
    }),
  );
  return {
    name: "eve:side-effect-modules",
    resolveId: {
      filter: { id: specifierFilter },
      handler(source: string, importer: string | undefined) {
        const sourceMountId = parseExtensionMountId(source).mountId;
        if (
          sourceMountId === undefined &&
          importer !== undefined &&
          parseExtensionMountId(importer).mountId !== undefined
        ) {
          return null;
        }
        const id = match(source, importer);
        if (id === null || !targetKeys.has(toKey(id, sourceMountId))) return null;
        return {
          id: sourceMountId === undefined ? id : tagExtensionMountId(id, sourceMountId),
          moduleSideEffects: "no-treeshake" as const,
        };
      },
    },
  };
}

function createStepTransformPlugin(
  rootDir: string,
  stepTargets: readonly string[],
  extensionMounts: readonly CompiledExtensionMount[],
) {
  const { idFilter, match } = createModulePathMatcher(rootDir, stepTargets);
  return {
    name: "eve:workflow-step-transform",
    transform: {
      filter: { id: idFilter },
      async handler(code: string, id: string) {
        const resolvedId = match(id);
        if (resolvedId === null) return null;
        const extensionMount = resolveExtensionMountForId(id, extensionMounts);
        const result = await applyWorkflowTransform(
          createRelativeTransformFilename(rootDir, resolvedId),
          code,
          "step",
          resolvedId,
          rootDir,
          undefined,
          extensionMount,
        );
        return result.code === code ? null : { code: result.code, map: null };
      },
    },
  };
}
