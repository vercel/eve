/** Sign-in state shared by connection search and connection tool calls. */

import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { getAuthorizationResults } from "#harness/authorization.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { resolveConnectionAuthorization } from "#runtime/connections/resolve-authorization.js";
import type {
  createAuthorizationExecution,
  ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { supportsInteractiveAuthorization } from "#shared/connection-types.js";
import { toErrorMessage } from "#shared/errors.js";

export type AuthorizationExecution = ReturnType<typeof createAuthorizationExecution>;

export function findConnection(
  registry: ConnectionRegistry,
  name: string,
): ResolvedConnectionDefinition | undefined {
  return registry.getConnections().find((connection) => connection.connectionName === name);
}

/** The interactive sign-in for a connection, when it supports one. */
export async function resolveInteractiveAuthorization(
  registry: ConnectionRegistry,
  connectionName: string,
): Promise<ScopedAuthorization | undefined> {
  const connection = findConnection(registry, connectionName);
  if (connection === undefined) return undefined;
  const authorization = await resolveConnectionAuthorization(connection);
  if (authorization === undefined || !supportsInteractiveAuthorization(authorization)) {
    return undefined;
  }
  return {
    scope: connection.connectionName,
    instanceId: connection.instanceId,
    connection: { url: connection.url ?? "" },
    authorization,
  };
}

/** Completes sign-in callbacks for the targeted connections only. */
export async function completePendingAuthorizations(
  registry: ConnectionRegistry,
  connections: readonly ResolvedConnectionDefinition[],
  auth: AuthorizationExecution,
): Promise<void> {
  assertPendingAuthorizationInstances(registry, connections);
  const results = getAuthorizationResults();
  for (const connection of connections) {
    if (!results.some((result) => result.name === connection.connectionName)) continue;
    const scoped = await resolveInteractiveAuthorization(registry, connection.connectionName);
    if (scoped === undefined) continue;
    await auth.complete(scoped);
    // A client that connected anonymously before sign-in must reconnect with the new token.
    if (auth.isJustAuthorized(scoped)) await registry.getClient(connection.connectionName).close();
  }
}

/** Rejects sign-in results for the targeted connections whose instance changed while pending. */
export function assertPendingAuthorizationInstances(
  registry: ConnectionRegistry,
  connections: readonly ResolvedConnectionDefinition[],
): void {
  const targeted = new Set(connections.map((connection) => connection.connectionName));
  for (const result of getAuthorizationResults()) {
    if (result.instanceId === undefined || !targeted.has(result.name)) continue;
    if (findConnection(registry, result.name)?.instanceId === result.instanceId) continue;
    throw new Error(
      `Authorization for "${result.name}" cannot complete because its resolved connection changed while sign-in was pending. Start sign-in again.`,
    );
  }
}

/** Why a connection's tools could not be listed, for a failure other than a needed sign-in. */
export function listingFailureMessage(connectionName: string, error: unknown): string {
  return isConnectionAuthorizationFailedError(error)
    ? `Authorization failed for "${connectionName}": ${error.message}`
    : `Failed to load tools for "${connectionName}": ${toErrorMessage(error)}`;
}
