import { dirname, isAbsolute, join, resolve } from "node:path";

import semver from "#compiled/semver/index.js";
import { createDiscoverErrorDiagnostic, type DiscoverDiagnostic } from "#discover/diagnostics.js";
import { parseExtensionMountSpecifier } from "#discover/extension-specifier.js";
import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "#discover/filesystem.js";
import type { ExtensionSourceRef } from "#discover/manifest.js";
import type { ProjectSource } from "#discover/project-source.js";

/**
 * Emitted when a mount file cannot be resolved to an extension package.
 */
export const DISCOVER_EXTENSION_MOUNT_UNRESOLVED = "discover/extension-mount-unresolved";

/**
 * Emitted when one namespace is claimed by both a file mount
 * (`extensions/<ns>.ts`) and a directory mount (`extensions/<ns>/`).
 */
export const DISCOVER_EXTENSION_MOUNT_AMBIGUOUS = "discover/extension-mount-ambiguous";

/**
 * Emitted when a directory mount (`extensions/<ns>/`) is missing its required
 * `extension.<ext>` mount declaration.
 */
export const DISCOVER_EXTENSION_MOUNT_MISSING_DECLARATION =
  "discover/extension-mount-missing-declaration";

/**
 * Emitted when an extension declares its own `extensions/` mount slot. Extensions
 * cannot mount other extensions yet; the slot is reserved so enabling nesting
 * later is additive rather than a surprise.
 */
export const DISCOVER_EXTENSION_NESTED_MOUNT_UNSUPPORTED =
  "discover/extension-nested-mount-unsupported";

/**
 * Emitted when a consumer's agent-root contribution (e.g. `agent/tools/crm__x.ts`)
 * uses a mounted extension's `<ns>__` prefix. That prefix is reserved for the
 * extension and its co-located overrides, not the agent root.
 */
export const DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT =
  "discover/extension-override-outside-mount";

/**
 * Emitted when a resolved package is not a valid eve extension.
 */
export const DISCOVER_EXTENSION_PACKAGE_INVALID = "discover/extension-package-invalid";

/**
 * Emitted when the app's eve version does not satisfy an extension's declared
 * `peerDependencies.eve` range — the tie between an extension and the eve it was
 * built for.
 */
export const DISCOVER_EXTENSION_EVE_INCOMPATIBLE = "discover/extension-eve-incompatible";

/**
 * Emitted when an extension source tree declares agent-level config (`agent.ts`),
 * which is the consuming agent's to own.
 */
export const DISCOVER_EXTENSION_AGENT_CONFIG_UNSUPPORTED =
  "discover/extension-agent-config-unsupported";

/**
 * Emitted when an extension source tree declares a `sandbox`, which is the
 * consuming agent's to own.
 */
export const DISCOVER_EXTENSION_SANDBOX_UNSUPPORTED = "discover/extension-sandbox-unsupported";

/**
 * Emitted when an extension source tree declares `schedules`. Background
 * scheduling runs sessions on the consuming agent's deployment under its limits,
 * so it is the consuming agent's to own, not an extension's.
 */
export const DISCOVER_EXTENSION_SCHEDULE_UNSUPPORTED = "discover/extension-schedule-unsupported";

/**
 * Resolved on-disk location of one mounted extension package.
 */
export interface ExtensionMountLocation {
  /** Mount namespace derived from the mount filename (e.g. `crm`). */
  readonly namespace: string;
  /** Package specifier the mount imports (e.g. `@acme/crm`). */
  readonly specifier: string;
  /** Package name from the resolved `package.json`, used to scope state. */
  readonly packageName: string;
  /** Absolute path to the resolved package root. */
  readonly packageRoot: string;
  /** Absolute path to the extension's agent-shaped source root. */
  readonly sourceRoot: string;
}

/**
 * Derives the mount namespace from an `extensions/<name>.<ext>` logical path.
 */
export function mountNamespace(logicalPath: string): string {
  const base = logicalPath.slice(logicalPath.lastIndexOf("/") + 1);
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (base.toLowerCase().endsWith(extension)) {
      return base.slice(0, base.length - extension.length);
    }
  }
  return base;
}

/**
 * Derives the mount namespace from a mount ref's `extensions/…` logical path
 * for either mount form: the file form (`extensions/crm.ts` → `crm`) or the
 * directory form (`extensions/crm/extension.ts` → `crm`).
 */
export function mountRefNamespace(logicalPath: string): string {
  const remainder = logicalPath.replace(/^extensions\//, "");
  const slashIndex = remainder.indexOf("/");
  if (slashIndex !== -1) {
    return remainder.slice(0, slashIndex);
  }
  return mountNamespace(logicalPath);
}

/**
 * Derives the namespace that scopes an extension's durable state keys and config
 * binding from its package name. Unlike the mount namespace, this stays keyed to
 * the package (e.g. `@acme/crm` → `acme-crm`) so renaming the consumer's mount
 * file never orphans persisted state.
 */
export function packageStateNamespace(packageName: string): string {
  return (
    packageName
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "extension"
  );
}

/**
 * Resolves one extension mount to its package and agent-shaped source root
 * without importing the mount module. Reads the mount source text to extract
 * the package specifier, resolves the package, and reads
 * `package.json#eve.extension` for the source root.
 */
export async function locateExtensionMount(input: {
  readonly source: ProjectSource;
  readonly agentRoot: string;
  readonly appRoot: string;
  readonly mount: ExtensionSourceRef;
  /**
   * Mount namespace the caller derived from the mount path — passed in because
   * the file and directory mount forms name it at different path positions.
   */
  readonly namespace: string;
  /** The app's eve version, checked against the extension's `peerDependencies.eve`. */
  readonly eveVersion: string;
}): Promise<{ location?: ExtensionMountLocation; diagnostics: DiscoverDiagnostic[] }> {
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
  let pkg: { name?: unknown; eve?: { extension?: unknown }; peerDependencies?: { eve?: unknown } };
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

  const extensionRoot = pkg.eve?.extension;
  if (typeof extensionRoot !== "string" || extensionRoot.length === 0) {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_PACKAGE_INVALID,
          message: `Package "${specifier}" is not an eve extension: its package.json is missing the \`eve.extension\` source-root field.`,
          sourcePath: manifestPath,
        }),
      ],
    };
  }

  const packageName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : specifier;

  // Tie the extension to the eve it was built for. Only a real semver range is
  // enforced; workspace/link/file protocols are resolved by the package manager.
  const peerRange = pkg.peerDependencies?.eve;
  if (
    typeof peerRange === "string" &&
    semver.validRange(peerRange) !== null &&
    !semver.intersects(input.eveVersion, peerRange)
  ) {
    return {
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: DISCOVER_EXTENSION_EVE_INCOMPATIBLE,
          message: `Extension "${packageName}" requires eve "${peerRange}", but this app uses eve ${input.eveVersion}. Upgrade the extension to a version that supports this eve, or align your eve version.`,
          sourcePath: manifestPath,
        }),
      ],
    };
  }

  return {
    location: {
      namespace,
      specifier,
      packageName,
      packageRoot,
      sourceRoot: resolve(packageRoot, extensionRoot),
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

/**
 * Returns the package portion of a bare specifier, dropping any deep subpath.
 * `@acme/crm/mount` → `@acme/crm`; `gizmo/mount` → `gizmo`.
 */
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
