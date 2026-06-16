import type { ConnectionSourceRef } from "#discover/manifest.js";
import {
  normalizeMcpClientConnectionDefinition,
  normalizeOpenApiConnectionDefinition,
} from "#internal/authored-definition/connection.js";
import type { CompiledConnectionDefinition } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { readConnectionProtocol } from "#public/definitions/connections/protocol.js";

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
  agentRoot: string,
  source: ConnectionSourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledConnectionDefinition> {
  const loaded = await loadModuleBackedDefinition({
    agentRoot,
    externalDependencies: options.externalDependencies,
    kind: "connection",
    source,
  });
  const protocol = readConnectionProtocol(loaded);
  const message = `Expected the connection export "${source.exportName ?? "default"}" from "${source.logicalPath}" to match the public eve shape.`;

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

  const vercelConnect = extractVercelConnectMarker(auth);
  if (vercelConnect !== undefined) {
    compiled.vercelConnect = vercelConnect;
  }

  return compiled;
}

/**
 * Reads the optional `vercelConnect: { connector: string }` marker that
 * `@vercel/connect/eve`'s `connect()` helper attaches to its returned
 * authorization definition. Returns the parsed marker when present and
 * shaped correctly, otherwise `undefined`.
 *
 * The compiler does not import `@vercel/connect/eve` (it should not
 * depend on a specific auth provider). Detection is duck-typed against
 * the structural marker contract — any object with a non-empty
 * `vercelConnect.connector` string is recognized.
 */
function extractVercelConnectMarker(auth: unknown): { readonly connector: string } | undefined {
  if (auth === null || typeof auth !== "object") {
    return undefined;
  }
  const marker = (auth as { vercelConnect?: unknown }).vercelConnect;
  if (marker === null || typeof marker !== "object") {
    return undefined;
  }
  const connector = (marker as { connector?: unknown }).connector;
  if (typeof connector !== "string" || connector.length === 0) {
    return undefined;
  }
  return { connector };
}
