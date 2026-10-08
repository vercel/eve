import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { isExtensionModule } from "#internal/bundler/extension-mount-plugin.js";

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

function shimSource(mountId: string): string {
  return [
    `import { defineMountedState } from "eve/internal/mount-state";`,
    `export function defineState(name, initial) {`,
    `  return defineMountedState(${JSON.stringify(mountId)}, name, initial);`,
    `}`,
    "",
  ].join("\n");
}

function extensionShimSource(mountId: string): string {
  return [
    `import { defineExtension as define } from "eve/extension";`,
    `export const defineExtension = (options) => define(options, ${JSON.stringify(mountId)});`,
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
      if (
        (source !== "eve/context" && source !== "eve/extension") ||
        importer === undefined ||
        importer.startsWith("\0")
      ) {
        return undefined;
      }
      const mountId = mountFor(importer);
      if (mountId === undefined) return undefined;
      if (source === "eve/extension") {
        return `${VIRTUAL_PREFIX}extension:${encodeURIComponent(mountId)}`;
      }
      if (source === "eve/context") {
        return `${VIRTUAL_PREFIX}context:${encodeURIComponent(mountId)}`;
      }
      return undefined;
    },
    load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) {
        return undefined;
      }
      const descriptor = id.slice(VIRTUAL_PREFIX.length);
      const separatorIndex = descriptor.indexOf(":");
      const kind = descriptor.slice(0, separatorIndex);
      if (kind !== "context" && kind !== "extension") return undefined;
      const mountId = decodeURIComponent(descriptor.slice(separatorIndex + 1));
      if (kind === "context") {
        return { code: shimSource(mountId), moduleType: "js" as const };
      }
      if (kind === "extension") {
        return { code: extensionShimSource(mountId), moduleType: "js" as const };
      }
      return undefined;
    },
  };
}

/**
 * Path-containment scope plugin for the whole-application bundle (the production
 * build). Any module physically under an extension's source root has its
 * `eve/context` and `eve/extension` imports redirected to mount-owned shims.
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
      return isExtensionModule(importerPath(importer), owned.root) ? owned.mountId : undefined;
    }
    const path = importerPath(importer);
    const matches = canonicalScopes.filter((scope) => isExtensionModule(path, scope.root));
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
