const PRUNED_CONNECTION_REGISTRY_MODULE_ID = "\0eve-pruned-connection-registry";
const PRUNED_CONNECTION_RESOLVER_MODULE_ID = "\0eve-pruned-connection-resolver";
const PRUNED_CONNECTION_SEARCH_MODULE_ID = "\0eve-pruned-connection-search";

const CONNECTION_REGISTRY_SOURCE_RE = /[/\\]runtime[/\\]connections[/\\]registry\.(?:[cm]?[jt]s)$/;
const CONNECTION_RESOLVER_SOURCE_RE = /[/\\]runtime[/\\]resolve-connection\.(?:[cm]?[jt]s)$/;
const CONNECTION_SEARCH_SOURCE_RE =
  /[/\\]runtime[/\\]framework-tools[/\\]connection-search-dynamic\.(?:[cm]?[jt]s)$/;

const PRUNED_MODULE_IDS_BY_SOURCE = new Map<string, string>([
  ["#runtime/connections/registry.js", PRUNED_CONNECTION_REGISTRY_MODULE_ID],
  ["#runtime/resolve-connection.js", PRUNED_CONNECTION_RESOLVER_MODULE_ID],
  ["#runtime/framework-tools/connection-search-dynamic.js", PRUNED_CONNECTION_SEARCH_MODULE_ID],
]);

interface BundlerPluginShape {
  readonly name: string;
  load?(id: string): string | null | undefined;
  resolveId?(
    source: string,
    importer: string | undefined,
  ): string | { id: string } | null | undefined;
}

function getPrunedModuleId(source: string): string | undefined {
  const directMatch = PRUNED_MODULE_IDS_BY_SOURCE.get(source);
  if (directMatch !== undefined) {
    return directMatch;
  }

  if (CONNECTION_REGISTRY_SOURCE_RE.test(source)) {
    return PRUNED_CONNECTION_REGISTRY_MODULE_ID;
  }
  if (CONNECTION_RESOLVER_SOURCE_RE.test(source)) {
    return PRUNED_CONNECTION_RESOLVER_MODULE_ID;
  }
  if (CONNECTION_SEARCH_SOURCE_RE.test(source)) {
    return PRUNED_CONNECTION_SEARCH_MODULE_ID;
  }

  return undefined;
}

function createPrunedRuntimeSource(exportSource: string): string {
  return [
    "function pruned() {",
    '  throw new Error("Connection runtime is pruned from this hosted bundle because the compiled manifest declares no connections.");',
    "}",
    exportSource,
    "",
  ].join("\n");
}

/**
 * Creates the hosted-bundle specialization for manifests that declare no
 * connections anywhere in their local graph. The core runtime always imports
 * these facades, but every call is guarded by the resolved connection list.
 * Replacing the facades keeps the MCP and OpenAPI clients, connection search,
 * and connection-definition hydration out of a function that cannot use them.
 */
export function createConnectionRuntimePrunePlugin(): BundlerPluginShape {
  return {
    name: "eve-hosted-connection-runtime-prune",
    load(id) {
      switch (id) {
        case PRUNED_CONNECTION_REGISTRY_MODULE_ID:
          return createPrunedRuntimeSource(
            [
              "export class ConnectionRegistryImpl {",
              "  constructor() {",
              "    pruned();",
              "  }",
              "}",
            ].join("\n"),
          );
        case PRUNED_CONNECTION_RESOLVER_MODULE_ID:
          return createPrunedRuntimeSource(
            "export async function resolveConnectionDefinition() {\n  pruned();\n}",
          );
        case PRUNED_CONNECTION_SEARCH_MODULE_ID:
          return createPrunedRuntimeSource(
            "export function createConnectionSearchResolver() {\n  return pruned();\n}",
          );
        default:
          return null;
      }
    },
    resolveId(source) {
      return getPrunedModuleId(source) ?? null;
    },
  };
}
