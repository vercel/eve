import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import {
  type AuthorizationChallenge,
  type AuthorizationSignal,
  getAuthorizationResult,
  getHookUrl,
  requestAuthorization,
} from "#harness/authorization.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#public/connections/errors.js";
import type { JsonValue } from "#public/types/json.js";
import type { JsonObject } from "#shared/json.js";
import { writeCachedToken } from "#runtime/connections/authorization-tokens.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import { resolveConnectionAuthorization } from "#runtime/connections/resolve-authorization.js";
import {
  resolveAuthorizationCallbackUrl,
  stampChallengeDisplayName,
} from "#runtime/connections/scoped-authorization.js";
import {
  type ConnectionRegistry,
  type ConnectionToolMetadata,
  type InteractiveAuthorizationDefinition,
  supportsInteractiveAuthorization,
} from "#runtime/connections/types.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import type { DynamicToolEvents, DynamicToolEntry } from "#shared/dynamic-tool-definition.js";
import type { ModelMessage } from "ai";

import { ConnectionRegistryKey } from "#context/providers/connection-key.js";

const logger = createLogger("framework.connection-search-dynamic");

const CONNECTION_SEARCH_RESULT_ITEM_SCHEMA: JsonObject = {
  additionalProperties: false,
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
  type: "object",
};

const CONNECTION_SEARCH_OUTPUT_SCHEMA: JsonObject = {
  items: CONNECTION_SEARCH_RESULT_ITEM_SCHEMA,
  type: "array",
};

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
): Promise<InteractiveAuthorizationDefinition | undefined> {
  const conn = registry.getConnections().find((c) => c.connectionName === connectionName);
  if (conn === undefined) return undefined;
  const authorization = await resolveConnectionAuthorization(conn);
  if (!supportsInteractiveAuthorization(authorization)) return undefined;
  return authorization as InteractiveAuthorizationDefinition;
}

/**
 * Completes any authorizations whose callback arrived this turn,
 * returning the set of connection names that were just (re-)authorized.
 *
 * Callers use the returned set as a loop guard: if a connection that was
 * just authorized still fails with `Required` on the immediately
 * following load, the freshly minted token is itself being rejected, so
 * the connection must fail terminally rather than re-challenge forever.
 */
async function completePendingAuthorizations(registry: ConnectionRegistry): Promise<Set<string>> {
  const ctx = loadContext();
  const completed = new Set<string>();
  for (const conn of registry.getConnections()) {
    const result = getAuthorizationResult(conn.connectionName);
    if (!result) continue;
    const auth = await resolveInteractiveAuth(registry, conn.connectionName);
    if (!auth) continue;
    const principal = resolveConnectionPrincipal(conn.connectionName, auth);
    const token = await (
      auth as InteractiveAuthorizationDefinition<JsonValue>
    ).completeAuthorization({
      callbackUrl: result.hookUrl,
      connection: { url: conn.url ?? "" },
      principal,
      resume: result.resume,
      callback: result.callback,
    });
    writeCachedToken(ctx, conn.connectionName, principalKey(principal), token);
    completed.add(conn.connectionName);
  }
  return completed;
}

async function executeConnectionSearch(
  input: ConnectionSearchInput,
): Promise<ConnectionSearchResultItem[] | AuthorizationSignal> {
  const ctx = loadContext();
  const registry = ctx.get(ConnectionRegistryKey);
  if (registry === undefined) {
    return [];
  }

  const justAuthorized = await completePendingAuthorizations(registry);

  const limit = input.limit ?? 10;
  const queryTokens = tokenize(input.keywords);
  const results: Array<{ item: ConnectionSearchResultItem; score: number }> = [];
  const failedConnections: ConnectionSearchResultItem[] = [];

  const targetConnections =
    input.connection !== undefined && input.connection !== ""
      ? registry.getConnections().filter((c) => c.connectionName === input.connection)
      : registry.getConnections();

  const authChallenges: AuthorizationChallenge[] = [];

  for (const conn of targetConnections) {
    let tools: readonly ConnectionToolMetadata[];
    try {
      const client = registry.getClient(conn.connectionName);
      tools = await client.getToolMetadata();
    } catch (err) {
      if (isConnectionAuthorizationRequiredError(err)) {
        // Loop guard: a connection authorized earlier this turn that is
        // still rejected means the new token itself is bad. Fail it
        // terminally instead of re-challenging into an infinite sign-in
        // loop.
        if (justAuthorized.has(conn.connectionName)) {
          logger.warn("connection still unauthorized after authorization", {
            connection: conn.connectionName,
          });
          failedConnections.push({
            connection: conn.connectionName,
            description: conn.description,
            error: `Authorization for "${conn.connectionName}" did not take effect; the token was rejected after sign-in.`,
          });
          continue;
        }

        const auth = await resolveInteractiveAuth(registry, conn.connectionName);
        if (auth) {
          const hookUrl = getHookUrl(conn.connectionName);
          if (hookUrl) {
            const principal = resolveConnectionPrincipal(conn.connectionName, auth);
            const callbackUrl = resolveAuthorizationCallbackUrl({
              authorization: auth,
              callbackUrl: hookUrl,
            });
            try {
              const { challenge, resume } = await auth.startAuthorization({
                callbackUrl,
                connection: { url: conn.url ?? "" },
                principal,
              });
              authChallenges.push({
                name: conn.connectionName,
                challenge: stampChallengeDisplayName(challenge, auth),
                hookUrl: callbackUrl,
                resume,
              });
            } catch (startErr) {
              logger.warn("startAuthorization failed", {
                connection: conn.connectionName,
                error: startErr instanceof Error ? startErr : new Error(String(startErr)),
              });
            }
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

      const message = err instanceof Error ? err.message : "unknown error";
      logger.warn("failed to load connection tools", {
        connection: conn.connectionName,
        error: err instanceof Error ? err : new Error(message),
      });
      failedConnections.push({
        connection: conn.connectionName,
        description: conn.description,
        error: `Failed to load tools for "${conn.connectionName}": ${message}`,
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

/**
 * Extracts connection search results from conversation history.
 * Scans tool-result messages for `connection_search` results and
 * returns deduplicated tool metadata (latest result wins per qualifiedName).
 */
export function extractDiscoveredTools(
  messages: readonly ModelMessage[],
): ConnectionSearchResultItem[] {
  const byQualifiedName = new Map<string, ConnectionSearchResultItem>();

  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const parts = msg.content as Array<{
      type: string;
      toolName?: string;
      output?: unknown;
    }>;
    for (const part of parts) {
      if (part.type !== "tool-result" || part.toolName !== "connection_search") continue;
      const output = part.output;
      if (output === undefined || output === null) continue;
      const items = (
        typeof output === "object" && "type" in output && "value" in output
          ? (output as { value: unknown }).value
          : output
      ) as unknown;
      if (!Array.isArray(items)) continue;
      for (const item of items as ConnectionSearchResultItem[]) {
        if (item.tool && item.qualifiedName) {
          byQualifiedName.set(item.qualifiedName, item);
        }
      }
    }
  }

  return [...byQualifiedName.values()];
}

/**
 * Creates the connection search dynamic tool resolver events.
 *
 * The resolver subscribes to `step.started` so it re-derives the tool
 * set from conversation history on every step. After compaction, old
 * `connection_search` results disappear from messages and discovered
 * tools naturally drop from the toolset.
 */
export function createConnectionSearchEvents(): DynamicToolEvents {
  return {
    "step.started": async (_event, ctx) => {
      const registry = loadContext().get(ConnectionRegistryKey);
      if (!registry || registry.getConnections().length === 0) return null;

      const connections = registry.getConnections();
      const connectionNames = connections.map((c) => c.connectionName);
      const fromMessages = extractDiscoveredTools(ctx.messages);
      const fromContext = loadContext().get(ConnectionSearchResultsKey) ?? [];
      const mergedMap = new Map<string, ConnectionSearchResultItem>();
      for (const r of fromContext) {
        if (r.qualifiedName) mergedMap.set(r.qualifiedName, r);
      }
      for (const r of fromMessages) {
        if (r.qualifiedName) mergedMap.set(r.qualifiedName, r);
      }
      const discovered = [...mergedMap.values()];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: Record<string, DynamicToolEntry<any, any>> = {};

      tools["connection_search"] = {
        description:
          "Search for tools across your connections. " +
          "Discovered tools become directly callable by their qualified name " +
          "(e.g. `linear__list_issues`) in your next response. " +
          `Available connections: ${connectionNames.join(", ")}.`,
        inputSchema: {
          type: "object" as const,
          additionalProperties: false,
          properties: {
            keywords: {
              description:
                "Search keywords and expanded aliases. Distill intent into keywords; avoid stop words like 'a', 'the', 'in'.",
              type: "string",
            },
            connection: {
              description: "Optional: limit search to a specific connection name.",
              type: "string",
            },
            limit: {
              description: "Max results to return. Default 10.",
              type: "number",
            },
          },
          required: ["keywords"],
        },
        async execute(input: ConnectionSearchInput) {
          return executeConnectionSearch(input);
        },
        outputSchema: CONNECTION_SEARCH_OUTPUT_SCHEMA,
      };

      for (const result of discovered) {
        const connectionName = result.connection;
        const toolName = result.tool!;
        const approval = registry.getConnectionApproval(connectionName);

        tools[qualifiedConnectionToolName(connectionName, toolName)] = {
          description: result.description,
          inputSchema: (result.inputSchema ?? {
            type: "object",
          }) as JsonObject,
          approval,
          outputSchema: result.outputSchema as JsonObject | undefined,
          async execute(input: Record<string, unknown>, executeCtx) {
            const reg = loadContext().get(ConnectionRegistryKey)!;
            const conn = reg.getConnections().find((c) => c.connectionName === connectionName);
            const interactiveAuth = (await resolveInteractiveAuth(reg, connectionName)) as
              | InteractiveAuthorizationDefinition<JsonValue>
              | undefined;

            let justCompletedAuth = false;
            if (interactiveAuth) {
              const authResult = getAuthorizationResult(connectionName);
              if (authResult) {
                justCompletedAuth = true;
                const ctx = loadContext();
                const principal = resolveConnectionPrincipal(connectionName, interactiveAuth);
                const token = await interactiveAuth.completeAuthorization({
                  callbackUrl: authResult.hookUrl,
                  connection: { url: conn?.url ?? "" },
                  principal,
                  resume: authResult.resume,
                  callback: authResult.callback,
                });
                writeCachedToken(ctx, connectionName, principalKey(principal), token);
              }
            }

            try {
              const client = reg.getClient(connectionName);
              return await client.executeTool(toolName, input, {
                abortSignal: executeCtx.abortSignal,
              });
            } catch (err) {
              if (!isConnectionAuthorizationRequiredError(err) || !interactiveAuth) {
                throw err;
              }

              // Loop guard: if we just completed authorization this turn and
              // the token is still rejected, the grant is broken — fail
              // terminally instead of re-prompting endlessly.
              if (justCompletedAuth) {
                throw new ConnectionAuthorizationFailedError(connectionName, {
                  retryable: false,
                  reason: "token_rejected_after_authorization",
                  message: `Connection "${connectionName}" rejected the token immediately after authorization.`,
                });
              }

              const hookUrl = getHookUrl(connectionName);
              if (!hookUrl) throw err;

              const principal = resolveConnectionPrincipal(connectionName, interactiveAuth);
              const callbackUrl = resolveAuthorizationCallbackUrl({
                authorization: interactiveAuth,
                callbackUrl: hookUrl,
              });
              const { challenge, resume } = await interactiveAuth.startAuthorization({
                callbackUrl,
                connection: { url: conn?.url ?? "" },
                principal,
              });

              return requestAuthorization([
                {
                  name: connectionName,
                  challenge: stampChallengeDisplayName(challenge, interactiveAuth),
                  hookUrl: callbackUrl,
                  resume,
                },
              ]);
            }
          },
        };
      }

      return tools;
    },
  };
}

/**
 * Creates a `ResolvedDynamicToolResolver` for the framework connection
 * search tool. Used by graph resolution to register alongside authored
 * dynamic tool resolvers.
 */
export function createConnectionSearchResolver(): ResolvedDynamicToolResolver {
  const events = createConnectionSearchEvents();
  return {
    slug: "connection",
    eventNames: Object.keys(events),
    events: events as ResolvedDynamicToolResolver["events"],
    sourceId: "eve:connection-search-dynamic",
    sourceKind: "module",
    logicalPath: "eve:framework/connection-search-dynamic",
  };
}
