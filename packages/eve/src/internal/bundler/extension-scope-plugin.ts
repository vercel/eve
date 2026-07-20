import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * One extension's on-disk source root paired with the namespace its durable
 * state keys and config binding must be scoped to.
 */
export interface ExtensionScope {
  /** Absolute path to the extension's source root. */
  readonly sourceRoot: string;
  /** Package-derived namespace (e.g. `acme-crm`). */
  readonly packageNamespace: string;
}

const VIRTUAL_PREFIX = "\0eve-ext-scope:";

/** Framework module an extension-owned import is redirected through. */
type ScopedFrameworkModule = "eve/context" | "eve/extension";

const SCOPED_FRAMEWORK_MODULES: Record<ScopedFrameworkModule, "context" | "extension"> = {
  "eve/context": "context",
  "eve/extension": "extension",
};

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

function shimSource(kind: "context" | "extension", namespace: string): string {
  const ns = JSON.stringify(namespace);
  if (kind === "context") {
    // Wrap `defineState` (the only runtime export) so the durable key is
    // prefixed with the namespace baked into the bundle, not read from
    // evaluation-order-sensitive global state.
    return [
      `import { defineState as __eveScopedDefineState } from "eve/context";`,
      `export function defineState(name, initial) {`,
      `  return __eveScopedDefineState(${ns} + "." + name, initial);`,
      `}`,
      "",
    ].join("\n");
  }
  // Wrap `defineExtension` (the only runtime export) so the handle bakes the
  // namespace — both the mount binding and the handle's `config` reader resolve
  // to the same scope from any module in the extension.
  return [
    `import { defineExtension as __eveScopedDefineExtension } from "eve/extension";`,
    `export function defineExtension(options, namespace) {`,
    `  return __eveScopedDefineExtension(options, namespace === undefined ? ${ns} : namespace);`,
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
      const kind = SCOPED_FRAMEWORK_MODULES[source as ScopedFrameworkModule];
      if (kind === undefined || importer === undefined || importer.startsWith("\0")) {
        return undefined;
      }
      const namespace = namespaceFor(importer);
      if (namespace === undefined) {
        return undefined;
      }
      return `${VIRTUAL_PREFIX}${kind}:${namespace}`;
    },
    load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) {
        return undefined;
      }
      const descriptor = id.slice(VIRTUAL_PREFIX.length);
      const separatorIndex = descriptor.indexOf(":");
      const kind = descriptor.slice(0, separatorIndex) as "context" | "extension";
      const namespace = descriptor.slice(separatorIndex + 1);
      return { code: shimSource(kind, namespace), moduleType: "js" as const };
    },
  };
}

/**
 * Path-containment scope plugin for the whole-application bundle (the production
 * build). Any module physically under an extension's source root has its
 * `eve/context`/`eve/extension` imports redirected to a generated shim that
 * bakes the extension's package namespace into `defineState`/`defineExtension`.
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
