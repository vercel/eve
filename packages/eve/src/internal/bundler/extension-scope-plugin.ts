import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { isExtensionModule } from "#internal/bundler/extension-mount-plugin.js";
import { exactRegex, prefixRegex } from "#internal/bundler/filters.js";

interface ExtensionScope {
  readonly sourceRoot: string;
  readonly mountId: string;
}

const VIRTUAL_PREFIX = "\0eve-ext-scope:";

export interface ExtensionScopeBundlerPlugin {
  readonly name: string;
  readonly resolveId: {
    readonly filter: { readonly id: RegExp };
    handler(source: string, importer: string | undefined): string | undefined;
  };
  readonly load: {
    readonly filter: { readonly id: RegExp };
    handler(id: string): { code: string; moduleType: "js" } | undefined;
  };
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

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

function scopeHooks(
  name: string,
  mountFor: (importer: string) => string | undefined,
): ExtensionScopeBundlerPlugin {
  return {
    name,
    resolveId: {
      filter: { id: exactRegex("eve/context") },
      handler(source: string, importer: string | undefined) {
        if (source !== "eve/context" || importer === undefined || importer.startsWith("\0")) {
          return undefined;
        }
        const mountId = mountFor(importer);
        if (mountId === undefined) return undefined;
        return `${VIRTUAL_PREFIX}context:${encodeURIComponent(mountId)}`;
      },
    },
    load: {
      filter: { id: prefixRegex(VIRTUAL_PREFIX) },
      handler(id: string) {
        if (!id.startsWith(VIRTUAL_PREFIX)) {
          return undefined;
        }
        const descriptor = id.slice(VIRTUAL_PREFIX.length);
        const separatorIndex = descriptor.indexOf(":");
        if (descriptor.slice(0, separatorIndex) !== "context") return undefined;
        const mountId = decodeURIComponent(descriptor.slice(separatorIndex + 1));
        return { code: shimSource(mountId), moduleType: "js" as const };
      },
    },
  };
}

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

export function createFixedMountScopePlugin(mountId: string): ExtensionScopeBundlerPlugin {
  return scopeHooks("eve-extension-scope-fixed", () => mountId);
}
