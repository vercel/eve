import type { Approval } from "#approval/definition.js";
import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import { OpenApiConnectionClient } from "#runtime/connections/openapi-client.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";

/**
 * Per-session container mapping connection names to lazily-initialized
 * client wrappers.
 *
 * The registry is protocol-agnostic: it dispatches to the client
 * implementation matching each connection's `protocol` (MCP or OpenAPI).
 */
export class ConnectionRegistryImpl implements ConnectionRegistry {
  #clients = new Map<string, ConnectionClient>();
  #connections: readonly ResolvedConnectionDefinition[];
  readonly #staticConnections: readonly ResolvedConnectionDefinition[];

  constructor(connections: readonly ResolvedConnectionDefinition[]) {
    this.#staticConnections = connections;
    this.#connections = connections;
  }

  /** Replaces the dynamic connections, by reaction, and closes clients whose definition changed. */
  async replaceDynamicConnections(
    connectionsByResolver: ReadonlyMap<string, readonly ResolvedConnectionDefinition[]>,
  ): Promise<void> {
    const next = this.#buildEffectiveConnections(connectionsByResolver);
    const previousByName = new Map(
      this.#connections.map((connection) => [connection.connectionName, connection]),
    );
    const nextByName = new Map(next.map((connection) => [connection.connectionName, connection]));
    const staleClients: ConnectionClient[] = [];

    for (const [name, client] of this.#clients) {
      if (previousByName.get(name) === nextByName.get(name)) continue;
      this.#clients.delete(name);
      staleClients.push(client);
    }

    this.#connections = next;
    await Promise.allSettled(staleClients.map((client) => client.close()));
  }

  #buildEffectiveConnections(
    effectiveResolvers: ReadonlyMap<string, readonly ResolvedConnectionDefinition[]>,
  ): readonly ResolvedConnectionDefinition[] {
    const dynamicNames = new Map<string, string>();
    const connections = new Map(
      this.#staticConnections.map((connection) => [connection.connectionName, connection]),
    );
    for (const [resolverSlug, definitions] of effectiveResolvers) {
      for (const definition of definitions) {
        const previousOwner = dynamicNames.get(definition.connectionName);
        if (previousOwner !== undefined && previousOwner !== resolverSlug) {
          throw new Error(
            `Dynamic connection "${definition.connectionName}" from resolver "${resolverSlug}" collides with dynamic resolver "${previousOwner}". Namespace the map key manually.`,
          );
        }
        dynamicNames.set(definition.connectionName, resolverSlug);
        connections.set(definition.connectionName, definition);
      }
    }
    for (const name of dynamicNames.keys()) assertNoNestedConnection(name, connections.keys());
    return [...connections.values()];
  }

  /**
   * Returns the client for the named connection, creating it on first
   * access. The connection's `protocol` selects the client type.
   */
  getClient(connectionName: string): ConnectionClient {
    const existing = this.#clients.get(connectionName);
    if (existing !== undefined) {
      return existing;
    }

    const connection = this.#connections.find((c) => c.connectionName === connectionName);
    if (connection === undefined) {
      throw new Error(`Connection "${connectionName}" is not registered.`);
    }

    const client: ConnectionClient =
      connection.protocol === "openapi"
        ? new OpenApiConnectionClient(connection)
        : new McpConnectionClient(connection);
    this.#clients.set(connectionName, client);
    return client;
  }

  /**
   * Returns the authored approval function for the named connection,
   * or `undefined` if the connection did not specify one.
   */
  getConnectionApproval(connectionName: string): Approval | undefined {
    const connection = this.#connections.find((c) => c.connectionName === connectionName);
    return connection?.approval;
  }

  /**
   * Returns all registered connection names.
   */
  getConnectionNames(): readonly string[] {
    return this.#connections.map((c) => c.connectionName);
  }

  /**
   * Returns the resolved definitions for all connections.
   */
  getConnections(): readonly ResolvedConnectionDefinition[] {
    return this.#connections;
  }

  /**
   * Closes all active client connections.
   */
  async dispose(): Promise<void> {
    const closePromises = [...this.#clients.values()].map((client) => client.close());
    await Promise.allSettled(closePromises);
    this.#clients.clear();
  }
}

/** A dynamic connection may neither own nor be owned by another connection's name. */
function assertNoNestedConnection(dynamicName: string, connectionNames: Iterable<string>): void {
  for (const other of connectionNames) {
    if (other === dynamicName) continue;
    // Only the shorter of two names can own the other.
    const [name, owner] =
      other.length < dynamicName.length ? [dynamicName, other] : [other, dynamicName];
    assertNotConnectionOwned({
      connectionNames: [owner],
      name,
      remedy: `Rename the dynamic connection "${dynamicName}".`,
      subject: "Connection",
    });
  }
}
