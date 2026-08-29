import type { CompiledConnectionDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import type { ConnectionToolCallDefinition } from "#public/definitions/connections/tool-call.js";
import {
  normalizeMcpClientConnectionDefinition,
  normalizeOpenApiConnectionDefinition,
} from "#internal/authored-definition/connection.js";
import { readStampedConnectionProtocol } from "#public/definitions/connections/protocol.js";
import {
  registerDefinitionSource,
  stampDefinitionKey,
} from "#internal/authored-definition/source-identity.js";
import { toErrorMessage } from "#shared/errors.js";
import type {
  ConnectionAuthResolver,
  HeadersDefinition,
  ToolFilterDefinition,
} from "#shared/connection-types.js";
import { normalizeAuthorizationSpec } from "#shared/validate-authorization.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";

/**
 * Resolves one compiled connection entry into a runtime-owned definition
 * with the live `auth`, `headers`, and `tools` objects attached
 * from the authored module.
 *
 * The compiled manifest only stores serializable metadata (`url`,
 * `description`, `connectionName`). Live values (`auth`,
 * `headers`, `tools`) are resolved at runtime by re-importing the
 * authored module so they can reference ambient state (environment
 * variables, `AlsContext`, etc.).
 */
export async function resolveConnectionDefinition(
  definition: CompiledConnectionDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedConnectionDefinition> {
  try {
    const resolvedExportValue = await loadResolvedModuleExport({
      definition,
      kindLabel: "connection",
      moduleMap,
      nodeId,
    });
    const resolvedRecord = expectObjectRecord(
      resolvedExportValue,
      `Expected the connection export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" to return an object.`,
    );

    const sourceEntry = {
      kind: "connection",
      logicalPath: definition.logicalPath,
      name: definition.connectionName,
    } as const;

    const sourceKey = `connection-source:${definition.sourceId}`;
    stampDefinitionKey(resolvedRecord, sourceKey);
    registerDefinitionSource(sourceKey, sourceEntry);
    // Use the compiled `url` (the MCP endpoint or OpenAPI base URL) as
    // the secondary key so it matches the authoring-time key stamped by
    // the `define*` factory for both protocols. The live record only
    // carries `url` for MCP connections.
    registerDefinitionSource(`connection:${definition.url}`, sourceEntry);

    const hasAuth = resolvedRecord.auth !== undefined;
    const hasHeaders = resolvedRecord.headers !== undefined;
    // OpenAPI connections express their filter as `operations`; MCP
    // connections as `tools`. Both normalize to the same shape.
    const filter =
      definition.protocol === "openapi" ? resolvedRecord.operations : resolvedRecord.tools;

    const result: {
      approval?: ResolvedConnectionDefinition["approval"];
      authorization?: ResolvedConnectionDefinition["authorization"];
      connectionName: string;
      description: string;
      exportName: typeof definition.exportName;
      headers?: Readonly<HeadersDefinition>;
      logicalPath: string;
      protocol: ResolvedConnectionDefinition["protocol"];
      sourceId: string;
      sourceKind: "module";
      spec?: ResolvedConnectionDefinition["spec"];
      toolCall?: Readonly<ConnectionToolCallDefinition>;
      tools?: Readonly<ToolFilterDefinition>;
      url: string;
    } = {
      connectionName: definition.connectionName,
      description: definition.description,
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      protocol: definition.protocol,
      sourceId: definition.sourceId,
      sourceKind: "module",
      url: definition.url,
    };

    if (hasAuth) {
      if (typeof resolvedRecord.auth === "function") {
        result.authorization = resolvedRecord.auth as ConnectionAuthResolver;
      } else {
        try {
          result.authorization = normalizeAuthorizationSpec(
            resolvedRecord.auth,
            `Connection "${definition.connectionName}" at "${definition.logicalPath}":`,
          );
        } catch (error) {
          throw new ResolveAgentError(toErrorMessage(error), {
            logicalPath: definition.logicalPath,
            sourceId: definition.sourceId,
          });
        }
      }
    }

    if (hasHeaders) {
      result.headers = resolvedRecord.headers as Readonly<HeadersDefinition>;
    }

    if (resolvedRecord.toolCall !== undefined) {
      result.toolCall = resolvedRecord.toolCall as Readonly<ConnectionToolCallDefinition>;
    }

    if (filter !== undefined) {
      result.tools = filter as Readonly<ToolFilterDefinition>;
    }

    if (definition.protocol === "openapi" && resolvedRecord.spec !== undefined) {
      result.spec = resolvedRecord.spec as ResolvedConnectionDefinition["spec"];
    }

    if (typeof resolvedRecord.approval === "function") {
      result.approval = resolvedRecord.approval as ResolvedConnectionDefinition["approval"];
    }

    return result;
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to resolve connection "${definition.connectionName}" from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: definition.logicalPath,
        sourceId: definition.sourceId,
      },
    );
  }
}

/** Resolves one branded connection returned by a dynamic connection handler. */
export function resolveDynamicConnectionValue(
  value: unknown,
  source: Readonly<ModuleSourceRef & { readonly connectionName: string }>,
): ResolvedConnectionDefinition {
  const protocol = readStampedConnectionProtocol(value);
  const message =
    `Dynamic connection "${source.connectionName}" from "${source.logicalPath}" must be created by ` +
    "defineMcpClientConnection() or defineOpenAPIConnection().";
  if (protocol === undefined) {
    throw new Error(message);
  }

  const sourceEntry = {
    kind: "connection",
    logicalPath: source.logicalPath,
    name: source.connectionName,
  } as const;
  const sourceKey = `dynamic-connection-source:${source.sourceId}:${source.connectionName}`;
  stampDefinitionKey(value as object, sourceKey);
  registerDefinitionSource(sourceKey, sourceEntry);

  if (protocol === "openapi") {
    const normalized = normalizeOpenApiConnectionDefinition(value, message);
    return omitUndefined({
      approval: normalized.approval,
      authorization: normalized.auth as ResolvedConnectionDefinition["authorization"],
      connectionName: source.connectionName,
      description: normalized.description,
      exportName: source.exportName,
      headers: normalized.headers,
      logicalPath: source.logicalPath,
      protocol,
      sourceId: source.sourceId,
      sourceKind: "module" as const,
      spec: normalized.spec,
      toolCall: normalized.toolCall,
      tools: normalized.operations,
      url: normalized.baseUrl ?? "",
    });
  }

  const normalized = normalizeMcpClientConnectionDefinition(value, message);
  return omitUndefined({
    approval: normalized.approval,
    authorization: normalized.auth as ResolvedConnectionDefinition["authorization"],
    connectionName: source.connectionName,
    description: normalized.description,
    exportName: source.exportName,
    headers: normalized.headers,
    logicalPath: source.logicalPath,
    protocol,
    sourceId: source.sourceId,
    sourceKind: "module" as const,
    toolCall: normalized.toolCall,
    tools: normalized.tools,
    url: normalized.url,
  });
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
