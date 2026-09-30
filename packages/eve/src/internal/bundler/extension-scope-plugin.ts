import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * One extension's on-disk source root paired with its logical mount identity.
 */
interface ExtensionScope {
  /** Absolute path to the extension's source root. */
  readonly sourceRoot: string;
  readonly mountId: string;
}

const VIRTUAL_PREFIX = "\0eve-ext-scope:";

/** The subset of the rolldown/rollup plugin shape this plugin implements. */
export interface ExtensionScopeBundlerPlugin {
  readonly name: string;
  resolveId(source: string, importer: string | undefined): string | undefined;
  load(id: string): { code: string; moduleType: "js" } | undefined;
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Strips a rolldown query suffix (`?v=…`) so containment compares real paths. */
function importerPath(importer: string): string {
  const queryIndex = importer.indexOf("?");
  return canonicalize(queryIndex === -1 ? importer : importer.slice(0, queryIndex));
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function shimSource(mountId: string): string {
  return [
    `import { defineMountedState } from "eve/internal/mount-state";`,
    `export function defineState(name, initial) {`,
    `  return defineMountedState(${JSON.stringify(mountId)}, name, initial);`,
    `}`,
    "",
  ].join("\n");
}

/**
 * Builds the resolveId/load hook pair shared by both plugin modes. `mountFor`
 * returns the owning mount for an importer, or `undefined` to leave the
 * import untouched.
 */
function scopeHooks(
  name: string,
  mountFor: (importer: string) => string | undefined,
): ExtensionScopeBundlerPlugin {
  return {
    name,
    resolveId(source: string, importer: string | undefined) {
      if (source !== "eve/context" || importer === undefined || importer.startsWith("\0")) {
        return undefined;
      }
      const mountId = mountFor(importer);
      if (mountId === undefined) return undefined;
      return `${VIRTUAL_PREFIX}context:${encodeURIComponent(mountId)}`;
    },
    load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) {
        return undefined;
      }
      const descriptor = id.slice(VIRTUAL_PREFIX.length);
      const separatorIndex = descriptor.indexOf(":");
      if (descriptor.slice(0, separatorIndex) !== "context") return undefined;
      const mountId = decodeURIComponent(descriptor.slice(separatorIndex + 1));
      return { code: shimSource(mountId), moduleType: "js" as const };
    },
  };
}

/**
 * Path-containment scope plugin for the whole-application bundle (the production
 * build). Any module physically under an extension's source root has its
 * `eve/context` imports redirected to a mount-owned state shim.
 *
 * Returns `null` when there are no extensions, so consumer-only builds carry no
 * extra plugin and their output is byte-identical to a non-extension build.
 */
export function createExtensionScopePlugin(
  scopes: readonly ExtensionScope[],
): ExtensionScopeBundlerPlugin | null {
  if (scopes.length === 0) {
    return null;
  }
  const canonicalScopes = scopes.map((scope) => ({
    root: canonicalize(scope.sourceRoot),
    mountId: scope.mountId,
  }));
  return scopeHooks("eve-extension-scope", (importer) => {
    const mountQuery = importer.indexOf("?eve-mount=");
    if (mountQuery >= 0) {
      const mountId = decodeURIComponent(importer.slice(mountQuery + "?eve-mount=".length));
      const owned = canonicalScopes.find((scope) => scope.mountId === mountId);
      if (owned === undefined) throw new Error(`Unknown extension mount "${mountId}".`);
      return isUnder(importerPath(importer), owned.root) ? owned.mountId : undefined;
    }
    const path = importerPath(importer);
    const matches = canonicalScopes.filter((scope) => isUnder(path, scope.root));
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      throw new Error(`Ambiguous extension scope for "${path}".`);
    }
    return matches[0]!.mountId;
  });
}

/**
 * Fixed-mount scope plugin for a single extension-owned module bundle (the
 * dev/eval per-module loader). The compiler already knows the owning mount,
 * so every module in the bundle — the entry plus its same-package dependencies —
 * is scoped, with no reliance on
 * filesystem path matching (which is unreliable under workspace symlinks).
 */
export function createFixedMountScopePlugin(mountId: string): ExtensionScopeBundlerPlugin {
  return scopeHooks("eve-extension-scope-fixed", () => mountId);
}
