import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  checkExtensionVersionCompatibility,
  EXTENSION_COMPATIBILITY_MANIFEST_FILENAME,
  parseExtensionCompatibilityManifest,
  UnsupportedExtensionManifestVersionError,
} from "#compiler/extension-compatibility.js";
import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import { parseExtensionMountSpecifier } from "#discover/extension-specifier.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import type { ExtensionSourceRef } from "#discover/manifest.js";
import { type ProjectSource, readPackageJsonName } from "#discover/project-source.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  parseBuiltInExtensionPackageRoots,
  parseExtensionPackageRoots,
} from "#shared/extension-package-contract.js";

const DISCOVER_EXTENSION_MOUNT_UNRESOLVED = "discover/extension-mount-unresolved";

export const DISCOVER_EXTENSION_MOUNT_AMBIGUOUS = "discover/extension-mount-ambiguous";

export const DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION =
  "discover/extension-mount-missing-declaration";

export const DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED =
  "discover/extension-nested-mount-unsupported";

const DISCOVER_EXTENSION_PACKAGE_INVALID = "discover/extension-package-invalid";

export const DISCOVER_EXTENSION_COMPATIBILITY_INVALID = "discover/extension-compatibility-invalid";

export const DISCOVER_EXTENSION_VERSION_INCOMPATIBLE = "discover/extension-version-incompatible";

export const DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED =
  "discover/extension-agent-config-unsupported";

export const DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED = "discover/extension-sandbox-unsupported";
export const DISCOVER_EXTENSION_MEMORY_UNSUPPORTED = "discover/extension-memory-unsupported";

export const DISCOVER_EXTENSION_INSTRUMENTATION_UNSUPPORTED =
  "discover/extension-instrumentation-unsupported";

interface ExtensionMountLocation {
  readonly namespace: string;
  readonly specifier: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly sourceRoot: string;
  readonly externalDependencies: readonly string[];
}

interface ExtensionMountPackageLocation {
  readonly namespace: string;
  readonly specifier: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly authoredSourceRoot?: string;
  readonly distRoot: string;
  readonly builtIn: boolean;
}

export function mountNamespace(logicalPath: string): string {
  const base = logicalPath.slice(logicalPath.lastIndexOf("/") + 1);
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (base.toLowerCase().endsWith(extension)) {
      return base.slice(0, base.length - extension.length);
    }
  }
  return base;
}

export function mountRefNamespace(logicalPath: string): string {
  const remainder = logicalPath.replace(/^extensions\//, "");
  const slashIndex = remainder.indexOf("/");
  if (slashIndex !== -1) {
    return remainder.slice(0, slashIndex);
  }
  return mountNamespace(logicalPath);
}

export async function locateExtensionMount(input: {
  readonly source: ProjectSource;
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly mount: ExtensionSourceRef;
  readonly namespace: string;
}): Promise<{ location?: ExtensionMountLocation; diagnostics: DiscoverDiagnostic[] }> {
  const locatedPackage = await locateExtensionMountPackage(input);
  if (locatedPackage.location === undefined) {
    return { diagnostics: locatedPackage.diagnostics };
  }

  const { location } = locatedPackage;
  if (location.builtIn) {
    return {
      location: {
        namespace: location.namespace,
        specifier: location.specifier,
        packageName: location.packageName,
        packageRoot: location.packageRoot,
        sourceRoot: location.distRoot,
        externalDependencies: [],
      },
      diagnostics: [],
    };
  }

  const compatibilityPath = join(location.distRoot, EXTENSION_COMPATIBILITY_MANIFEST_FILENAME);
  let compatibility;
  try {
    compatibility = parseExtensionCompatibilityManifest(
      await input.source.readTextFile(compatibilityPath),
      compatibilityPath,
    );
  } catch (error) {
    if (error instanceof UnsupportedExtensionManifestVersionError) {
      return {
        diagnostics: [
          createDiscoverErrorDiagnostic({
            code: DISCOVER_EXTENSION_VERSION_INCOMPATIBLE,
            message: `Extension "${location.packageName}" uses an old epoch-based distribution manifest at "${compatibilityPath}". Rebuild the extension with this eve release or install a compatible extension release.`,
            sourcePath: compatibilityPath,
          }),
        ],
      };
    }
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_COMPATIBILITY_INVALID,
          message: `Extension "${location.packageName}" has no valid compatibility manifest at "${compatibilityPath}". Rebuild or reinstall the extension. ${error instanceof Error ? error.message : String(error)}`,
          sourcePath: compatibilityPath,
        }),
      ],
    };
  }

  const incompatible = checkExtensionVersionCompatibility(
    compatibility,
    resolveInstalledPackageInfo().version,
  );
  if (incompatible !== undefined) {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_VERSION_INCOMPATIBLE,
          message:
            incompatible.kind === "newer-eve"
              ? `Extension "${location.packageName}" was built with eve ${incompatible.minimumVersion}. Upgrade eve to ${incompatible.minimumVersion} or later, or install an extension built with your eve version.`
              : `Extension "${location.packageName}" requires distribution contract ${incompatible.contractMajor}, which this eve does not support. Rebuild the extension with this eve or install a compatible extension release.`,
          sourcePath: compatibilityPath,
        }),
      ],
    };
  }

  return {
    location: {
      namespace: location.namespace,
      specifier: location.specifier,
      packageName: location.packageName,
      packageRoot: location.packageRoot,
      sourceRoot: location.distRoot,
      externalDependencies: compatibility.build?.externalDependencies ?? [],
    },
    diagnostics: [],
  };
}

export async function locateExtensionMountPackage(input: {
  readonly source: ProjectSource;
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly mount: ExtensionSourceRef;
  readonly namespace: string;
}): Promise<{
  location?: ExtensionMountPackageLocation;
  diagnostics: DiscoverDiagnostic[];
}> {
  const mountPath = join(input.agentRoot, input.mount.logicalPath);
  const { namespace } = input;

  let text: string;
  try {
    text = await input.source.readTextFile(mountPath);
  } catch {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_MOUNT_UNRESOLVED,
          message: `Could not read extension mount "${input.mount.logicalPath}".`,
          sourcePath: mountPath,
        }),
      ],
    };
  }

  const specifier = parseExtensionMountSpecifier(text);
  if (specifier === null) {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_MOUNT_UNRESOLVED,
          message:
            `Extension mount "${input.mount.logicalPath}" must default-export a mounted extension, ` +
            `e.g. \`export default crm({ ... })\` or \`export { default } from "@acme/crm"\`.`,
          sourcePath: mountPath,
        }),
      ],
    };
  }

  const packageRoot = await resolvePackageRoot({
    source: input.source,
    appRoot: input.appRoot,
    mountDirectory: dirname(mountPath),
    specifier,
  });
  if (packageRoot === null) {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_MOUNT_UNRESOLVED,
          message: `Could not resolve extension package "${specifier}" mounted by "${input.mount.logicalPath}".`,
          sourcePath: mountPath,
        }),
      ],
    };
  }

  const manifestPath = join(packageRoot, "package.json");
  let pkg: { name?: unknown; eve?: { extension?: unknown; builtInExtensions?: unknown } };
  try {
    pkg = JSON.parse(await input.source.readTextFile(manifestPath)) as typeof pkg;
  } catch {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_PACKAGE_INVALID,
          message: `Extension package "${specifier}" has no readable package.json at "${manifestPath}".`,
          sourcePath: manifestPath,
        }),
      ],
    };
  }

  const builtInExtension = parseBuiltInExtensionPackageRoots(
    pkg.eve?.builtInExtensions,
    packageSpecifierSubpath(specifier),
  );
  const extension = builtInExtension ?? parseExtensionPackageRoots(pkg.eve?.extension);
  if (extension === null) {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_PACKAGE_INVALID,
          message: `Package "${specifier}" is not an eve extension: its package.json must declare \`eve.extension.dist\`.`,
          sourcePath: manifestPath,
        }),
      ],
    };
  }

  const packageName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : specifier;

  return {
    location: {
      namespace,
      specifier,
      packageName,
      packageRoot,
      ...(extension.source === undefined
        ? {}
        : { authoredSourceRoot: resolve(packageRoot, extension.source) }),
      builtIn: builtInExtension !== null,
      distRoot: resolve(packageRoot, extension.dist),
    },
    diagnostics: [],
  };
}

async function resolvePackageRoot(input: {
  readonly source: ProjectSource;
  readonly appRoot: string;
  readonly mountDirectory: string;
  readonly specifier: string;
}): Promise<string | null> {
  if (input.specifier.startsWith(".")) {
    const target = resolve(input.mountDirectory, input.specifier);
    return (await hasPackageJson(input.source, target)) ? target : null;
  }

  if (isAbsolute(input.specifier)) {
    return (await hasPackageJson(input.source, input.specifier)) ? input.specifier : null;
  }

  const packageSubpath = bareSpecifierPackagePath(input.specifier);
  if ((await readPackageJsonName(input.source, input.appRoot)) === packageSubpath) {
    return resolve(input.appRoot);
  }
  let current = resolve(input.appRoot);
  while (true) {
    const candidate = join(current, "node_modules", packageSubpath);
    if (await hasPackageJson(input.source, candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function packageSpecifierSubpath(specifier: string): string {
  const subpath = specifier.slice(bareSpecifierPackagePath(specifier).length);
  return subpath.length === 0 ? "." : `.${subpath}`;
}

function bareSpecifierPackagePath(specifier: string): string {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] ?? specifier;
}

async function hasPackageJson(source: ProjectSource, packageRoot: string): Promise<boolean> {
  return (await source.stat(join(packageRoot, "package.json"))) === "file";
}
