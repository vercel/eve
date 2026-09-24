import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

/** Marker carried by the object an extension handle produces when called. */
const MOUNTED_EXTENSION = Symbol.for("eve.mounted-extension");

/** The validated config a mount call produced, read back when the agent graph resolves. */
const MOUNTED_CONFIG = Symbol.for("eve.mounted-extension-config");

const CONFIG_REGISTRY = Symbol.for("eve.extension-config-registry");

/** Per-agent-node configs: extension namespace, then node id. */
const NODE_CONFIG_REGISTRY = Symbol.for("eve.extension-node-config-registry");

/** Returns the agent node id of the active session, installed by the runtime. */
const CURRENT_NODE_RESOLVER = Symbol.for("eve.extension-config-current-node");

/**
 * Ambient namespace set by the dev/eval loader around a mount module's
 * evaluation. A mount loads the handle unbundled (cross-package), so the
 * bundler's scope shim never runs on it; this fallback lets the mount still bind
 * under the package namespace. The shim's explicit argument takes precedence.
 */
const EXT_CONFIG_SCOPE = Symbol.for("eve.ext-config-scope");

function ambientConfigScope(): string | undefined {
  const scope = (globalThis as Record<symbol, unknown>)[EXT_CONFIG_SCOPE];
  return typeof scope === "string" && scope.length > 0 ? scope : undefined;
}

/** Process-global map of extension namespace to its bound, validated config. */
function configRegistry(): Map<string, Record<string, unknown>> {
  const container = globalThis as Record<symbol, unknown>;
  let registry = container[CONFIG_REGISTRY] as Map<string, Record<string, unknown>> | undefined;
  if (registry === undefined) {
    registry = new Map();
    container[CONFIG_REGISTRY] = registry;
  }
  return registry;
}

type NodeConfigs = ReadonlyMap<string, Record<string, unknown>>;

function nodeConfigRegistry(): Map<string, NodeConfigs> {
  const container = globalThis as Record<symbol, unknown>;
  let registry = container[NODE_CONFIG_REGISTRY] as Map<string, NodeConfigs> | undefined;
  if (registry === undefined) {
    registry = new Map();
    container[NODE_CONFIG_REGISTRY] = registry;
  }
  return registry;
}

function currentNodeId(): string | undefined {
  const resolve = (globalThis as Record<symbol, unknown>)[CURRENT_NODE_RESOLVER];
  return typeof resolve === "function" ? (resolve as () => string | undefined)() : undefined;
}

/**
 * Returns the config a mount module's default export was called with, or
 * `undefined` for a bare (no-config) mount.
 */
export function readMountedExtensionConfig(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || !(MOUNTED_CONFIG in value)) {
    return undefined;
  }
  return (value as { readonly [MOUNTED_CONFIG]: Record<string, unknown> })[MOUNTED_CONFIG];
}

/**
 * Binds each agent node's mount config for one extension namespace, so the
 * handle's `config` resolves per session node instead of to the last mount
 * evaluated. `resolveCurrentNodeId` returns the active session's node id.
 */
export function bindExtensionNodeConfigs(
  configsByNamespace: ReadonlyMap<string, NodeConfigs>,
  resolveCurrentNodeId: () => string | undefined,
): void {
  (globalThis as Record<symbol, unknown>)[CURRENT_NODE_RESOLVER] = resolveCurrentNodeId;
  const registry = nodeConfigRegistry();
  for (const [namespace, configs] of configsByNamespace) {
    registry.set(namespace, configs);
  }
}

/**
 * Marker value an extension handle returns when called. The consumer's mount
 * file default-exports it (directly for a no-config extension, or as the result
 * of the factory call for a configured one). The build reads the mount statically
 * for its package specifier; the runtime evaluates it so the call binds config
 * into the extension's scope.
 */
export interface MountedExtension {
  readonly [MOUNTED_EXTENSION]: true;
}

/**
 * Typed handle returned by {@link defineExtension} for an extension that declares
 * config. It is the mount factory the consumer calls (`crm({ apiKey })`), which
 * validates and binds the values; the extension's own tools, hooks, and
 * connections read the bound config through {@link ExtensionHandle.config}.
 */
export interface ExtensionHandle<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** Consumer mount factory: validates `values` against the schema and binds them. */
  (values: StandardSchemaV1.InferInput<S>): MountedExtension;
  /** The bound configuration, typed from the schema (defaults applied). */
  readonly config: StandardSchemaV1.InferOutput<S>;
  /** The declared config schema; read by `eve extension build`. */
  readonly schema: S;
}

/**
 * Handle returned by {@link defineExtension} for an extension with no config.
 * Mounted with a bare re-export; {@link NoConfigExtensionHandle.config} is empty.
 */
export interface NoConfigExtensionHandle {
  (): MountedExtension;
  readonly config: Record<string, never>;
  readonly schema: undefined;
}

/**
 * Validates consumer config through the extension's Standard Schema, applying
 * defaults. Binding runs while the mount module evaluates, so async validation
 * is rejected.
 */
function validateConfig(
  schema: StandardSchemaV1 | undefined,
  values: unknown,
): Record<string, unknown> {
  if (schema === undefined) {
    return {};
  }
  const result = schema["~standard"].validate(values ?? {});
  if (result instanceof Promise) {
    throw new Error(
      "Extension config must validate synchronously; the config schema uses async validation, which is not supported at mount.",
    );
  }
  if (result.issues !== undefined) {
    const detail = result.issues
      .map((issue) => {
        const path = issue.path
          ?.map((segment) => String(typeof segment === "object" ? segment.key : segment))
          .join(".");
        return path !== undefined && path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new Error(`Invalid extension config: ${detail}`);
  }
  return result.value as Record<string, unknown>;
}

/**
 * Declares an eve extension. Optionally takes a `config` schema — any Standard
 * Schema (e.g. a Zod object) — describing the settings a consuming agent passes
 * at the mount site.
 *
 * The default export of an extension's `extension/extension.ts` is a `defineExtension`
 * handle. A consuming agent mounts it, calling the handle to bind config
 * (`export default crm({ apiKey })`) or re-exporting it directly when there is no
 * config (`export { default } from "@acme/gizmo"`). The extension's own tools,
 * hooks, and connections read the bound config through the handle:
 *
 * ```ts
 * // extension/extension.ts
 * import { defineExtension } from "eve/extension";
 * import { z } from "zod";
 * export default defineExtension({ config: z.object({ apiKey: z.string() }) });
 *
 * // extension/tools/search.ts
 * import extension from "../extension.js";
 * const { apiKey } = extension.config;
 * ```
 *
 * The `namespace` argument is supplied by the bundler shim and is not part of the
 * authoring surface.
 */
export function defineExtension<const S extends StandardSchemaV1>(
  options: { readonly config: S },
  namespace?: string,
): ExtensionHandle<S>;
export function defineExtension(
  options?: { readonly config?: undefined },
  namespace?: string,
): NoConfigExtensionHandle;
export function defineExtension(
  options?: { readonly config?: StandardSchemaV1 },
  namespace?: string,
): ExtensionHandle | NoConfigExtensionHandle {
  const schema = options?.config;
  // The bundler shim passes the namespace explicitly for the extension's own
  // bundled modules; an unshimmed cross-package mount falls back to the ambient
  // scope the loader sets around the mount evaluation.
  const resolvedNamespace = namespace ?? ambientConfigScope();

  const handle = ((values?: unknown): MountedExtension => {
    const parsed = validateConfig(schema, values);
    if (resolvedNamespace !== undefined && resolvedNamespace.length > 0) {
      configRegistry().set(resolvedNamespace, parsed);
    }
    return { [MOUNTED_EXTENSION]: true, [MOUNTED_CONFIG]: parsed } as MountedExtension;
  }) as ExtensionHandle & NoConfigExtensionHandle;

  Object.defineProperty(handle, "schema", { value: schema, enumerable: true });
  Object.defineProperty(handle, "config", {
    enumerable: true,
    get(): Record<string, unknown> {
      if (resolvedNamespace === undefined) {
        return validateConfig(schema, {});
      }
      // Inside a session, read the config of the mount serving that agent node.
      // Outside one (e.g. module top level) fall back to the last mount bound.
      const nodeId = currentNodeId();
      const bound =
        (nodeId === undefined
          ? undefined
          : nodeConfigRegistry().get(resolvedNamespace)?.get(nodeId)) ??
        configRegistry().get(resolvedNamespace);
      return bound ?? validateConfig(schema, {});
    },
  });

  return handle;
}
