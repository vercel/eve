import type { Approval } from "#public/definitions/approval.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import { OpenApiConnectionClient } from "#runtime/connections/openapi-client.js";
import type { ConnectionClient, ConnectionRegistry } from "#runtime/connections/types.js";

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

  constructor(connections: readonly ResolvedConnectionDefinition[]) {
    this.#connections = connections;
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
