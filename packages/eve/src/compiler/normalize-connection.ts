import type { ConnectionSourceRef } from "#discover/manifest.js";
import {
  normalizeMcpClientConnectionDefinition,
  normalizeOpenApiConnectionDefinition,
} from "#internal/authored-definition/connection.js";
import type {
  CompiledConnectionDefinition,
  CompiledDynamicConnectionDefinition,
} from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { readConnectionProtocol } from "#public/definitions/connections/protocol.js";
import { extractVercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import {
  ALLOWED_DYNAMIC_CONNECTION_EVENTS,
  assertResolverOnlyDynamicSentinel,
  isDynamicSentinel,
  type DynamicToolEventName,
} from "#dynamic/definition.js";

export type CompiledConnectionEntry =
  | { readonly kind: "connection"; readonly definition: CompiledConnectionDefinition }
  | {
      readonly kind: "dynamic-connection";
      readonly definition: CompiledDynamicConnectionDefinition;
    };

/**
 * Compiles one authored connection module into the serializable metadata
 * stored on the compiled agent manifest.
 *
 * The compiled manifest holds only serializable data. The live authored
 * `auth` callback (and, for OpenAPI connections, the `spec` and
 * `operations` filter) is resolved at runtime by re-importing the
 * authored module -- see `runtime/resolve-connection.ts`. Compile-time
 * still imports and validates the module so authoring errors surface
 * during `eve build`.
 *
 * The wire protocol is read from the marker stamped by the `define*`
 * factory, defaulting to MCP, and selects which normalizer validates
 * the authored shape. `url` carries the MCP server endpoint for MCP
 * connections and the API base URL for OpenAPI connections, so the rest
 * of the connection pipeline (auth context, tool-result narrowing,
 * runtime resolution) stays protocol-agnostic.
 */
export async function compileConnectionDefinition(
  _agentRoot: string,
  source: ConnectionSourceRef,
  options: ModuleBackedDefinitionLoadOptions,
): Promise<CompiledConnectionEntry> {
  const loaded = await loadModuleBackedDefinition({
    binding: options.binding,
    kind: "connection",
    loadNamespace: options.loadNamespace,
    source,
  });
  const message = `Expected the connection export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`;

  if (isDynamicSentinel(loaded)) {
    assertResolverOnlyDynamicSentinel(loaded, message);
    const eventNames = Object.keys(loaded.events);
    const unsupportedEvent = eventNames.find(
      (eventName) => !ALLOWED_DYNAMIC_CONNECTION_EVENTS.has(eventName),
    );
    if (unsupportedEvent !== undefined) {
      throw new Error(
        `${message} Dynamic connections support only "session.started" and "turn.started" handlers. Unsupported event: "${unsupportedEvent}".`,
      );
    }
    return {
      kind: "dynamic-connection",
      definition: {
        eventNames: eventNames as DynamicToolEventName[],
        exportName: source.exportName,
        logicalPath: source.logicalPath,
        slug: source.connectionName,
        sourceId: source.sourceId,
        sourceKind: "module",
      },
    };
  }

  const protocol = readConnectionProtocol(loaded);

  const shared = {
    connectionName: source.connectionName,
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    sourceId: source.sourceId,
    sourceKind: "module",
  } as const;

  let compiled: CompiledConnectionDefinition;
  let auth: unknown;

  if (protocol === "openapi") {
    const normalized = normalizeOpenApiConnectionDefinition(loaded, message);
    compiled = {
      ...shared,
      description: normalized.description,
      protocol: "openapi",
      url: normalized.baseUrl ?? "",
    };
    auth = normalized.auth;
  } else {
    const normalized = normalizeMcpClientConnectionDefinition(loaded, message);
    compiled = {
      ...shared,
      description: normalized.description,
      protocol: "mcp",
      url: normalized.url,
    };
    auth = normalized.auth;
  }

  const vercelConnect = extractVercelConnectMetadata(
    auth === null || typeof auth !== "object"
      ? undefined
      : (auth as { readonly vercelConnect?: unknown }).vercelConnect,
  );
  if (vercelConnect !== undefined) {
    compiled.vercelConnect = vercelConnect;
  }

  return { definition: compiled, kind: "connection" };
}
