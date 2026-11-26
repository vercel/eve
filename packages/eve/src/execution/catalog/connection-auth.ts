import {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { getAuthorizationResults } from "#harness/authorization.js";
import { createLogger } from "#internal/logging.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { passesToolFilter } from "#runtime/connections/tool-filter.js";
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
import { CALL_TOOL_NAME } from "#protocol/catalog-tools.js";

const log = createLogger("framework.catalog-connections");

export interface ConnectionSession {
  readonly auth: ReturnType<typeof createAuthorizationExecution>;
  readonly client: ConnectionClient;
  readonly scoped: ScopedAuthorization | undefined;
}

export async function completeConnectionSignIn(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
): Promise<ConnectionSession> {
  assertPendingSignInInstance(connection);
  const scoped = await interactiveAuthorization(connection);
  const auth = createAuthorizationExecution();
  if (scoped !== undefined) await auth.complete(scoped);
  const client = registry.getClient(connection.connectionName);
  if (scoped !== undefined && auth.isJustAuthorized(scoped)) await client.close();
  return { auth, client, scoped };
}

export type ConnectionListing =
  | { readonly tools: readonly ConnectionToolMetadata[] }
  | { readonly authorization: ScopedAuthorization; readonly error: unknown }
  | { readonly error?: unknown; readonly failure: string };

export async function listConnectionTools(
  connection: ResolvedConnectionDefinition,
  session: ConnectionSession,
): Promise<ConnectionListing> {
  const name = connection.connectionName;
  try {
    return { tools: await listToolMetadata(connection, session.client) };
  } catch (error) {
    if (!isConnectionAuthorizationRequiredError(error)) {
      log.warn("failed to load connection tools", { connection: name, error });
      return {
        ...(isConnectionAuthorizationFailedError(error) && { error }),
        failure: listingFailureMessage(name, error),
      };
    }
    return authorizationRequired(name, session, error);
  }
}

export function authorizationRequired(
  name: string,
  { auth, scoped }: Pick<ConnectionSession, "auth" | "scoped">,
  error: unknown,
): Exclude<ConnectionListing, { readonly tools: unknown }> {
  if (scoped === undefined) {
    return { failure: `"${name}" requires authorization and cannot start interactive sign-in.` };
  }
  if (auth.isJustAuthorized(scoped)) {
    return {
      failure: `Authorization failed for "${name}": the service rejected the token immediately after authorization.`,
    };
  }
  return { authorization: scoped, error };
}

const LISTING_TIMEOUT_MS = 10_000;

class ListingTimeoutError extends Error {}

export async function withListingDeadline<T>(
  connectionName: string,
  list: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ListingTimeoutError(
          `"${connectionName}" did not list its tools within ${LISTING_TIMEOUT_MS / 1000}s. Try again later.`,
        ),
      );
    }, LISTING_TIMEOUT_MS);
  });
  try {
    return await Promise.race([list(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function listToolMetadata(
  connection: Pick<ResolvedConnectionDefinition, "connectionName" | "tools">,
  client: ConnectionClient,
): Promise<readonly ConnectionToolMetadata[]> {
  const tools = await withListingDeadline(connection.connectionName, () =>
    client.getToolMetadata(),
  );
  return tools.filter((tool) =>
    passesToolFilter(
      tool.operationId === undefined ? [tool.name] : [tool.name, tool.operationId],
      connection.tools,
    ),
  );
}

export function listingFailureMessage(connectionName: string, error: unknown): string {
  if (error instanceof ListingTimeoutError) return error.message;
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

function assertPendingSignInInstance(connection: ResolvedConnectionDefinition): void {
  for (const result of getAuthorizationResults()) {
    if (result.name !== connection.connectionName || result.instanceId === undefined) continue;
    if (result.instanceId === connection.instanceId) continue;
    throw new Error(
      `Authorization for "${result.name}" cannot complete because its resolved connection changed while sign-in was pending. Sign in again with ${CALL_TOOL_NAME}({ name: "${result.name}" }).`,
    );
  }
}
