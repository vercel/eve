import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

/** Marker carried by the object an extension handle produces when called. */
const MOUNTED_EXTENSION = Symbol.for("eve.mounted-extension");

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
 * The second argument is retained for source compatibility with compiled extension
 * declarations; instance bindings come from the loaded module graph, not its value.
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
  _namespace?: string,
): ExtensionHandle | NoConfigExtensionHandle {
  const schema = options?.config;
  let bound: Record<string, unknown> | undefined;
  const handle = ((values?: unknown): MountedExtension => {
    bound = validateConfig(schema, values);
    return { [MOUNTED_EXTENSION]: true };
  }) as ExtensionHandle & NoConfigExtensionHandle;

  Object.defineProperty(handle, "schema", { value: schema, enumerable: true });
  Object.defineProperty(handle, "config", {
    enumerable: true,
    get(): Record<string, unknown> {
      return bound ?? validateConfig(schema, {});
    },
  });

  return handle;
}
