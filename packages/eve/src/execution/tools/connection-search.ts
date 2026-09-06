import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  type AuthorizationChallenge,
  type AuthorizationSignal,
  getAuthorizationResults,
  requestAuthorization,
} from "#harness/authorization.js";
import {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { defineTool } from "#tools/definition.js";
import type { ToolContext } from "#tools/definition.js";
import {
  resolveApprovalPolicy,
  type ApprovalContext,
  type ApprovalResponseContext,
} from "#approval/definition.js";
import type { JsonObject } from "#shared/json.js";
import { stampDurableDynamicToolCallbacks } from "#tools/durable-callbacks.js";
import { resolveConnectionAuthorization } from "#runtime/connections/resolve-authorization.js";
import {
  createAuthorizationExecution,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import {
  type ConnectionToolMetadata,
  supportsInteractiveAuthorization,
} from "#shared/connection-types.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import { toError } from "#shared/errors.js";

import { ConnectionRegistryKey } from "#context/providers/connection-key.js";

const logger = createLogger("framework.connection-search-dynamic");

const CONNECTION_SEARCH_INPUT_SCHEMA = z.strictObject({
  connection: z
    .string()
    .describe("Optional: limit search to a specific connection name.")
    .optional(),
  keywords: z
    .string()
    .describe(
      "Search keywords and expanded aliases. Distill intent into keywords; avoid stop words like 'a', 'the', 'in'.",
    ),
  limit: z.number().describe("Max results to return. Default 10.").optional(),
});

const connectionSchema = z.looseObject({});
const CONNECTION_SEARCH_RESULT_ITEM_SCHEMA = z.strictObject({
  connection: z.string(),
  description: z.string(),
  error: z.string().optional(),
  inputSchema: connectionSchema.optional(),
  needsAuthorization: z.boolean().optional(),
  outputSchema: connectionSchema.optional(),
  qualifiedName: z.string().optional(),
  tool: z.string().optional(),
});

const CONNECTION_SEARCH_OUTPUT_SCHEMA = z.array(CONNECTION_SEARCH_RESULT_ITEM_SCHEMA);

/**
 * Durable context key for connection search results. Written by
 * `executeConnectionSearch` so the resolver can find discovered tools without
 * relying on model-facing tool result history.
 */
const ConnectionSearchResultsKey = new ContextKey<readonly ConnectionSearchResultItem[]>(
  "eve.connectionSearchResults",
);

/**
 * Builds the qualified tool name for a connection tool.
 */
function qualifiedConnectionToolName(connectionName: string, toolName: string): string {
  return `${connectionName}__${toolName}`;
}

interface ConnectionSearchInput {
  readonly connection?: string;
  readonly keywords: string;
  readonly limit?: number;
}

interface ConnectionSearchResultItem {
  readonly connection: string;
  readonly description: string;
  readonly error?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly needsAuthorization?: boolean;
  readonly outputSchema?: Record<string, unknown>;
  readonly tool?: string;
  readonly qualifiedName?: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((t) => t.length > 1);
}

function scoreMatch(queryTokens: string[], tool: ConnectionToolMetadata): number {
  const nameTokens = tokenize(tool.name);
  const descTokens = tokenize(tool.description);
  let score = 0;

  for (const qt of queryTokens) {
    for (const nt of nameTokens) {
      if (nt.includes(qt) || qt.includes(nt)) {
        score += 3;
      }
    }
    for (const dt of descTokens) {
      if (dt.includes(qt) || qt.includes(dt)) {
        score += 1;
      }
    }
  }

  return score;
}

async function resolveInteractiveAuth(
  registry: ConnectionRegistry,
  connectionName: string,
): Promise<ScopedAuthorization | undefined> {
  const conn = registry.getConnections().find((c) => c.connectionName === connectionName);
  if (conn === undefined) return undefined;
  const authorization = await resolveConnectionAuthorization(conn);
  if (authorization === undefined || !supportsInteractiveAuthorization(authorization))
    return undefined;
  return {
    scope: conn.connectionName,
    instanceId: conn.instanceId,
    connection: { url: conn.url ?? "" },
    authorization,
  };
}

/** Complete only callbacks for the connections targeted by this search. */
async function completePendingAuthorizations(
  registry: ConnectionRegistry,
  connections: readonly ResolvedConnectionDefinition[],
  auth: ReturnType<typeof createAuthorizationExecution>,
): Promise<void> {
  assertPendingConnectionAuthorizationInstances(registry);
  for (const conn of connections) {
    if (!getAuthorizationResults().some((result) => result.name === conn.connectionName)) continue;
    const scoped = await resolveInteractiveAuth(registry, conn.connectionName);
    if (scoped !== undefined) await auth.complete(scoped);
  }
}

async function executeConnectionSearch(
  input: ConnectionSearchInput,
): Promise<ConnectionSearchResultItem[] | AuthorizationSignal> {
  const ctx = loadContext();
  const registry = ctx.get(ConnectionRegistryKey);
  if (registry === undefined) {
    return [];
  }

  const limit = input.limit ?? 10;
  const queryTokens = tokenize(input.keywords);
  const results: Array<{ item: ConnectionSearchResultItem; score: number }> = [];
  const failedConnections: ConnectionSearchResultItem[] = [];

  const targetConnections =
    input.connection !== undefined && input.connection !== ""
      ? registry.getConnections().filter((c) => c.connectionName === input.connection)
      : registry.getConnections();

  if (input.connection && targetConnections.length === 0) {
    throw new Error(
      `Connection "${input.connection}" is not registered. Available connections: ${registry.getConnectionNames().join(", ")}.`,
    );
  }

  const auth = createAuthorizationExecution();
  await completePendingAuthorizations(registry, targetConnections, auth);

  const authChallenges: AuthorizationChallenge[] = [];

  for (const conn of targetConnections) {
    let tools: readonly ConnectionToolMetadata[];
    try {
      const client = registry.getClient(conn.connectionName);
      tools = await client.getToolMetadata();
    } catch (err) {
      if (isConnectionAuthorizationRequiredError(err)) {
        const scoped = await resolveInteractiveAuth(registry, conn.connectionName);
        if (scoped !== undefined) {
          try {
            const signal = await auth.handleError(err, scoped);
            authChallenges.push(...signal.challenges);
          } catch (startErr) {
            const error = toError(startErr);
            logger.warn("connection authorization failed", {
              connection: conn.connectionName,
              error,
            });
            failedConnections.push({
              connection: conn.connectionName,
              description: conn.description,
              error: isConnectionAuthorizationFailedError(error)
                ? error.message
                : `Failed to start authorization for "${conn.connectionName}": ${error.message}`,
            });
            continue;
          }
        }
        failedConnections.push({
          connection: conn.connectionName,
          description: conn.description,
          needsAuthorization: true,
        });
        continue;
      }

      if (isConnectionAuthorizationFailedError(err)) {
        logger.warn("connection authorization failed", {
          connection: conn.connectionName,
          reason: err.reason,
          retryable: err.retryable,
          error: err,
        });
        failedConnections.push({
          connection: conn.connectionName,
          description: conn.description,
          error: `Authorization failed for ${conn.connectionName}: ${err.message}`,
        });
        continue;
      }

      const error = toError(err);
      logger.warn("failed to load connection tools", {
        connection: conn.connectionName,
        error,
      });
      failedConnections.push({
        connection: conn.connectionName,
        description: conn.description,
        error: `Failed to load tools for "${conn.connectionName}": ${error.message}`,
      });
      continue;
    }

    for (const tool of tools) {
      const score = scoreMatch(queryTokens, tool);
      if (score > 0) {
        results.push({
          item: {
            connection: conn.connectionName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            qualifiedName: qualifiedConnectionToolName(conn.connectionName, tool.name),
            tool: tool.name,
          },
          score,
        });
      }
    }
  }

  if (authChallenges.length > 0) {
    return requestAuthorization(authChallenges);
  }

  const terminalFailures = failedConnections.filter((failure) => failure.error !== undefined);
  if (targetConnections.length > 0 && terminalFailures.length === targetConnections.length) {
    // When every targeted connection reaches a terminal error, connection_search itself fails.
    // AI SDK catches this rejection, emits a tool-error result, and preserves the failed call in
    // agent-run observability. Partial failures stay in the successful result so usable tools remain discoverable.
    throw new Error(terminalFailures.map((failure) => failure.error).join("\n"));
  }

  results.sort((a, b) => b.score - a.score);
  const matched = results.slice(0, limit).map((r) => r.item);

  if (matched.length > 0) {
    const allResults = [...matched, ...failedConnections];
    const existing = ctx.get(ConnectionSearchResultsKey) ?? [];
    const merged = new Map(existing.map((r) => [r.qualifiedName, r]));
    for (const r of matched) {
      if (r.qualifiedName) merged.set(r.qualifiedName, r);
    }
    ctx.set(ConnectionSearchResultsKey, [...merged.values()]);
    return allResults;
  }

  const summaries: ConnectionSearchResultItem[] = targetConnections.map((c) => {
    const failed = failedConnections.find((f) => f.connection === c.connectionName);
    if (failed) return failed;
    return {
      connection: c.connectionName,
      description: c.description,
    };
  });

  return summaries;
}

function readDiscoveredToolClosure(closure: JsonObject): {
  readonly connectionName: string;
  readonly toolName: string;
} {
  const connectionName = closure.connectionName;
  const toolName = closure.toolName;
  if (typeof connectionName !== "string" || typeof toolName !== "string") {
    throw new Error("Discovered connection tool callback metadata is invalid.");
  }
  return { connectionName, toolName };
}

async function executeDiscoveredConnectionTool(
  closure: JsonObject,
  input: Record<string, unknown>,
  executeCtx: ToolContext,
): Promise<unknown> {
  const { connectionName, toolName } = readDiscoveredToolClosure(closure);
  const registry = loadContext().get(ConnectionRegistryKey);
  if (registry === undefined) {
    throw new Error("Connection registry is unavailable while replaying a discovered tool.");
  }
  assertPendingConnectionAuthorizationInstances(registry);
  const scoped = await resolveInteractiveAuth(registry, connectionName);
  const auth = createAuthorizationExecution();
  if (scoped !== undefined) await auth.complete(scoped);
  try {
    const client = registry.getClient(connectionName);
    return await client.executeTool(toolName, input, {
      abortSignal: executeCtx.abortSignal,
      callId: executeCtx.callId,
    });
  } catch (error) {
    return await auth.handleError(error, scoped);
  }
}

function assertPendingConnectionAuthorizationInstances(registry: ConnectionRegistry): void {
  const connections = new Map(
    registry.getConnections().map((connection) => [connection.connectionName, connection]),
  );
  for (const result of getAuthorizationResults()) {
    if (result.instanceId === undefined) continue;
    if (connections.get(result.name)?.instanceId === result.instanceId) continue;
    throw new Error(
      `Authorization for "${result.name}" cannot complete because its resolved connection changed while sign-in was pending. Start sign-in again.`,
    );
  }
}

async function requestDiscoveredConnectionToolApproval(
  closure: JsonObject,
  context: ApprovalContext,
) {
  const { connectionName } = readDiscoveredToolClosure(closure);
  const approval = loadContext().get(ConnectionRegistryKey)?.getConnectionApproval(connectionName);
  return approval === undefined ? "not-applicable" : await resolveApprovalPolicy(approval)(context);
}

async function authorizeDiscoveredConnectionToolApproval(
  closure: JsonObject,
  context: ApprovalResponseContext,
) {
  const { connectionName } = readDiscoveredToolClosure(closure);
  const approval = loadContext().get(ConnectionRegistryKey)?.getConnectionApproval(connectionName);
  const response =
    approval === undefined || typeof approval === "function" ? undefined : approval.response;
  return response === undefined
    ? { reason: "Approval response authorization is unavailable.", status: "rejected" as const }
    : await response(context);
}

export async function resolveConnectionSearchDynamicTools() {
  const registry = loadContext().get(ConnectionRegistryKey);
  if (!registry || registry.getConnections().length === 0) return null;

  const connections = registry.getConnections();
  const connectionNames = connections.map((c) => c.connectionName);
  const activeConnectionNames = new Set(connectionNames);
  const discovered = (loadContext().get(ConnectionSearchResultsKey) ?? []).filter((result) =>
    activeConnectionNames.has(result.connection),
  );

  const tools: Record<string, object> = {};

  const connectionSearchTool = defineTool({
    description:
      "Search for tools across your connections. " +
      "Discovered tools become directly callable by their qualified name " +
      "(e.g. `linear__list_issues`) in your next response. " +
      `Available connections: ${connectionNames.join(", ")}.`,
    inputSchema: CONNECTION_SEARCH_INPUT_SCHEMA,
    async execute(input: ConnectionSearchInput) {
      return executeConnectionSearch(input);
    },
    outputSchema: CONNECTION_SEARCH_OUTPUT_SCHEMA,
  });
  stampDurableDynamicToolCallbacks(connectionSearchTool, {
    execute: {
      callback: (_closure, input) => executeConnectionSearch(input as ConnectionSearchInput),
      closure: {},
    },
  });
  tools["connection_search"] = connectionSearchTool;

  for (const result of discovered) {
    const connectionName = result.connection;
    const toolName = result.tool!;
    const approval = registry.getConnectionApproval(connectionName);

    const closure = { connectionName, toolName };
    const discoveredTool = defineTool({
      description: result.description,
      inputSchema: (result.inputSchema ?? {
        type: "object",
      }) as JsonObject,
      approval,
      outputSchema: result.outputSchema as JsonObject | undefined,
      async execute(input: Record<string, unknown>, executeCtx) {
        return await executeDiscoveredConnectionTool(closure, input, executeCtx);
      },
    });
    stampDurableDynamicToolCallbacks(discoveredTool, {
      execute: { callback: executeDiscoveredConnectionTool, closure },
      ...(approval === undefined
        ? {}
        : {
            approvalRequest: {
              callback: requestDiscoveredConnectionToolApproval,
              closure,
            },
          }),
      ...(approval === undefined ||
      typeof approval === "function" ||
      approval.response === undefined
        ? {}
        : {
            approvalResponse: {
              callback: authorizeDiscoveredConnectionToolApproval,
              closure,
            },
          }),
    });
    tools[qualifiedConnectionToolName(connectionName, toolName)] = discoveredTool;
  }

  return tools;
}
