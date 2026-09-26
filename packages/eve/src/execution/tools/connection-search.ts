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
import { defineJsonSchema } from "#tools/schema.js";
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

// Every match becomes a callable tool with its full schema, so one search must not flood the tool set.
const CONNECTION_SEARCH_MAX_RESULTS = 20;

const CONNECTION_SEARCH_INPUT_SCHEMA = defineJsonSchema<ConnectionSearchInput>({
  type: "object",
  properties: {
    connection: {
      type: "string",
      description:
        "Optional connection name from the Available connections list. Omit to search every connection.",
    },
    keywords: {
      type: "string",
      description:
        "Space-separated keywords for the action and its likely synonyms, e.g. 'list issues tickets'. Avoid stop words like 'a', 'the', 'in'.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: CONNECTION_SEARCH_MAX_RESULTS,
      description: `Maximum matching tools to return, from 1 to ${String(CONNECTION_SEARCH_MAX_RESULTS)}. Defaults to 10.`,
    },
  },
  required: ["keywords"],
  additionalProperties: false,
});

const CONNECTION_SEARCH_OUTPUT_SCHEMA = defineJsonSchema<ConnectionSearchResultItem[]>({
  type: "array",
  items: {
    type: "object",
    properties: {
      connection: { type: "string" },
      description: { type: "string" },
      error: { type: "string" },
      inputSchema: { type: "object" },
      needsAuthorization: { type: "boolean" },
      outputSchema: { type: "object" },
      qualifiedName: { type: "string" },
      tool: { type: "string" },
    },
    required: ["connection", "description"],
    additionalProperties: false,
  },
});

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
  if (authorization === undefined || !supportsInteractiveAuthorization(authorization)) {
    return undefined;
  }
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

export function connectionToolReplayIdentity(toolName: string): string | undefined {
  const ctx = loadContext();
  const discovered = ctx
    .get(ConnectionSearchResultsKey)
    ?.find((entry) => entry.qualifiedName === toolName);
  if (discovered === undefined) return;
  return ctx
    .get(ConnectionRegistryKey)
    ?.getConnections()
    .find((connection) => connection.connectionName === discovered.connection)?.instanceId;
}

function assertConnectionToolInstance(closure: JsonObject): void {
  if (typeof closure.instanceId !== "string") return;
  const { connectionName } = readDiscoveredToolClosure(closure);
  const connection = loadContext()
    .get(ConnectionRegistryKey)
    ?.getConnections()
    .find((entry) => entry.connectionName === connectionName);
  if (connection?.instanceId !== closure.instanceId) {
    throw new Error(
      "The connection for this tool call changed or is unavailable. Request a new tool call and approval.",
    );
  }
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
  assertConnectionToolInstance(closure);
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
  assertConnectionToolInstance(closure);
  const approval = loadContext().get(ConnectionRegistryKey)?.getConnectionApproval(connectionName);
  return approval === undefined ? "not-applicable" : await resolveApprovalPolicy(approval)(context);
}

async function authorizeDiscoveredConnectionToolApproval(
  closure: JsonObject,
  context: ApprovalResponseContext,
) {
  const { connectionName } = readDiscoveredToolClosure(closure);
  assertConnectionToolInstance(closure);
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
    description: [
      "Search the tools published by your connections, then call a match directly.",
      "",
      "Usage:",
      "- Search for the action you need, such as 'create invoice' or 'list open issues', not for the service name alone.",
      "- Pass connection when you already know which service owns the action; omit it to search every connection.",
      "- Each match includes its qualified name (e.g. `linear__list_issues`) and input schema. Matches become directly callable by qualified name in your next response. Call a tool that is already available instead of searching for it again.",
      "- A result with needsAuthorization: true means that connection must be authorized before its tools work. Tell the user instead of retrying the search.",
      "- A result with error means that connection failed to load its tools; other connections in the same result still work.",
      "- When nothing matches, the result lists each connection's description. Retry with different keywords or a specific connection.",
      "",
      `Available connections: ${connectionNames.join(", ")}.`,
    ].join("\n"),
    inputSchema: CONNECTION_SEARCH_INPUT_SCHEMA,
    async execute(input: ConnectionSearchInput) {
      return executeConnectionSearch(input);
    },
    outputSchema: CONNECTION_SEARCH_OUTPUT_SCHEMA,
  });
  stampDurableDynamicToolCallbacks(connectionSearchTool, {
    inputSchema: { callback: () => CONNECTION_SEARCH_INPUT_SCHEMA, closure: {} },
    outputSchema: { callback: () => CONNECTION_SEARCH_OUTPUT_SCHEMA, closure: {} },
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

    const instanceId = connections.find(
      (connection) => connection.connectionName === connectionName,
    )?.instanceId;
    const closure: { connectionName: string; toolName: string; instanceId?: string } = {
      connectionName,
      toolName,
    };
    if (instanceId !== undefined) closure.instanceId = instanceId;
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
