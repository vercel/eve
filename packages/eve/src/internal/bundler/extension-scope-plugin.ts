import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * One extension's on-disk source root paired with the namespace its durable
 * state keys use.
 */
export interface ExtensionScope {
  /** Absolute path to the extension's source root. */
  readonly sourceRoot: string;
  /** Package-derived namespace (e.g. `acme-crm`). */
  readonly packageNamespace: string;
}

const VIRTUAL_PREFIX = "\0eve-ext-scope:";

const SCOPED_FRAMEWORK_MODULE = "eve/context";

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

function shimSource(namespace: string): string {
  const ns = JSON.stringify(namespace);
  return [
    `import { defineState as __eveScopedDefineState } from "eve/context";`,
    `export function defineState(name, initial) {`,
    `  return __eveScopedDefineState(${ns} + "." + name, initial);`,
    `}`,
    "",
  ].join("\n");
}

/**
 * Builds the resolveId/load hook pair shared by both plugin modes. `namespaceFor`
 * returns the scope namespace for a given importer, or `undefined` to leave the
 * import untouched.
 */
function scopeHooks(
  name: string,
  namespaceFor: (importer: string) => string | undefined,
): ExtensionScopeBundlerPlugin {
  return {
    name,
    resolveId(source: string, importer: string | undefined) {
      if (
        source !== SCOPED_FRAMEWORK_MODULE ||
        importer === undefined ||
        importer.startsWith("\0")
      ) {
        return undefined;
      }
      const namespace = namespaceFor(importer);
      if (namespace === undefined) {
        return undefined;
      }
      return `${VIRTUAL_PREFIX}${namespace}`;
    },
    load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) {
        return undefined;
      }
      const namespace = id.slice(VIRTUAL_PREFIX.length);
      return { code: shimSource(namespace), moduleType: "js" as const };
    },
  };
}

/**
 * Path-containment scope plugin for the whole-application bundle (the production
 * build). Any module physically under an extension's source root has its
 * `eve/context` imports redirected to a generated shim that prefixes
 * `defineState` keys with the extension's package namespace.
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
    packageNamespace: scope.packageNamespace,
  }));
  return scopeHooks("eve-extension-scope", (importer) => {
    const path = importerPath(importer);
    for (const scope of canonicalScopes) {
      if (isUnder(path, scope.root)) {
        return scope.packageNamespace;
      }
    }
    return undefined;
  });
}

/**
 * Fixed-namespace scope plugin for a single extension-owned module bundle (the
 * dev/eval per-module loader). The compiler already knows the loaded module is
 * extension-owned and under which namespace, so every module in the bundle —
 * the entry plus its same-package dependencies — is scoped, with no reliance on
 * filesystem path matching (which is unreliable under workspace symlinks).
 */
export function createFixedNamespaceScopePlugin(namespace: string): ExtensionScopeBundlerPlugin {
  return scopeHooks("eve-extension-scope-fixed", () => namespace);
}
