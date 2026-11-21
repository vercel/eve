import type { Approval } from "#approval/definition.js";
import { assertNotConnectionOwned } from "#connections/ownership.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { McpConnectionClient } from "#runtime/connections/mcp-client.js";
import type { McpClientPool } from "#runtime/connections/mcp-client-pool.js";
import { OpenApiConnectionClient } from "#runtime/connections/openapi-client.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";

export interface ConnectionClientSharing {
  readonly pool: McpClientPool;
  readonly scope: string;
}

export class ConnectionRegistryImpl implements ConnectionRegistry {
  #clients = new Map<string, ConnectionClient>();
  #connections: readonly ResolvedConnectionDefinition[];
  readonly #staticConnections: readonly ResolvedConnectionDefinition[];
  readonly #sharing: ConnectionClientSharing | undefined;
  readonly #pooled = new Set<McpConnectionClient>();
  #disposed = false;

  constructor(
    connections: readonly ResolvedConnectionDefinition[],
    sharing?: ConnectionClientSharing,
  ) {
    this.#staticConnections = connections;
    this.#connections = connections;
    this.#sharing = sharing;
  }

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
    await Promise.allSettled(staleClients.map((client) => this.#returnClient(client, true)));
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
        : this.#mcpClient(connection);
    this.#clients.set(connectionName, client);
    return client;
  }

  getConnectionApproval(connectionName: string): Approval | undefined {
    const connection = this.#connections.find((c) => c.connectionName === connectionName);
    return connection?.approval;
  }

  getConnectionNames(): readonly string[] {
    return this.#connections.map((c) => c.connectionName);
  }

  getStaticConnectionNames(): readonly string[] {
    return this.#staticConnections.map((c) => c.connectionName);
  }

  getConnections(): readonly ResolvedConnectionDefinition[] {
    return this.#connections;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(clients.map((client) => this.#returnClient(client, false)));
  }

  #mcpClient(connection: ResolvedConnectionDefinition): McpConnectionClient {
    const sharing = this.#sharing;
    if (sharing === undefined || this.#disposed || !this.#staticConnections.includes(connection)) {
      return new McpConnectionClient(connection);
    }
    const client = sharing.pool.acquire(sharing.scope, connection);
    this.#pooled.add(client);
    return client;
  }

  async #returnClient(client: ConnectionClient, discard: boolean): Promise<void> {
    if (client instanceof McpConnectionClient && this.#pooled.delete(client)) {
      await this.#sharing?.pool.release(client, { discard });
    } else {
      await client.close();
    }
  }
}

function assertNoNestedConnection(dynamicName: string, connectionNames: Iterable<string>): void {
  for (const other of connectionNames) {
    if (other === dynamicName) continue;
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
