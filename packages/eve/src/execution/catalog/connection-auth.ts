/** Sign-in shared by connection tool calls, searches, and connecting a connection. */

import {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { getAuthorizationResults } from "#harness/authorization.js";
import { createLogger } from "#internal/logging.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { resolveConnectionAuthorization } from "#runtime/connections/resolve-authorization.js";
import {
  createAuthorizationExecution,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import {
  supportsInteractiveAuthorization,
  type ConnectionClient,
  type ConnectionToolMetadata,
} from "#shared/connection-types.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("framework.catalog-connections");

/** A connection ready for one call, with any sign-in the user finished completed. */
export interface ConnectionSession {
  /** Completes and starts sign-in for this call, and guards against a sign-in loop. */
  readonly auth: ReturnType<typeof createAuthorizationExecution>;
  readonly client: ConnectionClient;
  /** The connection's interactive sign-in, when it supports one. */
  readonly scoped: ScopedAuthorization | undefined;
}

/**
 * Completes the sign-in the user finished for `connection`, if any, before its
 * client is used. Every path that lists or calls a connection's tools starts
 * here, and none of them prompts.
 */
export async function completeConnectionSignIn(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
): Promise<ConnectionSession> {
  assertPendingSignInInstance(connection);
  const scoped = await interactiveAuthorization(connection);
  const auth = createAuthorizationExecution();
  if (scoped !== undefined) await auth.complete(scoped);
  const client = registry.getClient(connection.connectionName);
  // A client that connected anonymously before sign-in must reconnect with the new token.
  if (scoped !== undefined && auth.isJustAuthorized(scoped)) await client.close();
  return { auth, client, scoped };
}

/** A connection's tools, or why they can't be listed. */
export type ConnectionListing =
  | { readonly tools: readonly ConnectionToolMetadata[] }
  /** Listable once the user signs in; `error` is the listing's request for sign-in. */
  | { readonly error: unknown; readonly signIn: ScopedAuthorization }
  | { readonly failure: string };

export async function listConnectionTools(
  connection: ResolvedConnectionDefinition,
  { auth, client, scoped }: ConnectionSession,
): Promise<ConnectionListing> {
  const name = connection.connectionName;
  try {
    return { tools: await client.getToolMetadata() };
  } catch (error) {
    if (!isConnectionAuthorizationRequiredError(error)) {
      log.warn("failed to load connection tools", { connection: name, error });
      return { failure: listingFailureMessage(name, error) };
    }
    if (scoped === undefined) {
      return { failure: `"${name}" requires authorization and cannot start interactive sign-in.` };
    }
    // The token the user just signed in with was refused; asking again would loop.
    if (auth.isJustAuthorized(scoped)) {
      return {
        failure: `Authorization failed for "${name}": the service rejected the token immediately after authorization.`,
      };
    }
    return { error, signIn: scoped };
  }
}

/** Why a connection's tools could not be listed, for a failure other than a needed sign-in. */
export function listingFailureMessage(connectionName: string, error: unknown): string {
  return isConnectionAuthorizationFailedError(error)
    ? `Authorization failed for "${connectionName}": ${error.message}`
    : `Failed to load tools for "${connectionName}": ${toErrorMessage(error)}`;
}

async function interactiveAuthorization(
  connection: ResolvedConnectionDefinition,
): Promise<ScopedAuthorization | undefined> {
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

/** Rejects a finished sign-in for `connection` when its resolved instance changed while pending. */
function assertPendingSignInInstance(connection: ResolvedConnectionDefinition): void {
  for (const result of getAuthorizationResults()) {
    if (result.name !== connection.connectionName || result.instanceId === undefined) continue;
    if (result.instanceId === connection.instanceId) continue;
    throw new Error(
      `Authorization for "${result.name}" cannot complete because its resolved connection changed while sign-in was pending. Start sign-in again.`,
    );
  }
}
