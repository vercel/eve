/**
 * `connection_search` and `connection_execute`: fixed tools that reach every
 * connection tool without adding definitions to the model's tool list, so
 * discovery never changes the cached prompt prefix. Both are rebuilt each
 * step from the connection registry with identical model-facing definitions.
 */

import type { Approval } from "#approval/definition.js";
import {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { loadContext } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { getAuthorizationResults, type AuthorizationSignal } from "#harness/authorization.js";
import { reportNestedToolAction } from "#harness/nested-actions.js";
import { createLogger } from "#internal/logging.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import { resolveConnectionAuthorization } from "#runtime/connections/resolve-authorization.js";
import {
  createAuthorizationExecution,
  type ScopedAuthorization,
} from "#runtime/connections/scoped-authorization.js";
import {
  connectionToolModelOutput,
  toConnectionToolResult,
} from "#runtime/connections/tool-result.js";
import { renderToolSignature } from "#runtime/connections/tool-signature.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import {
  supportsInteractiveAuthorization,
  type ConnectionToolMetadata,
} from "#shared/connection-types.js";
import { displayProperName } from "#shared/display-name.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import { defineDurableCallback } from "#tools/durable-callbacks.js";
import { defineTool, type ToolContext } from "#tools/definition.js";
import type { DynamicToolSet } from "#tools/dynamic.js";
import { defineJsonSchema } from "#tools/schema.js";

import { connectionExecuteApproval } from "./connection-approval.js";
import {
  closestToolNames,
  rankConnectionTools,
  type RankCandidate,
} from "./connection-search-rank.js";
import {
  CONNECTION_EXECUTE_TOOL_NAME,
  findConnection,
  qualifiedToolName,
  readExecuteTarget,
  toolCallDisplayName,
} from "./connection-target.js";

const log = createLogger("framework.connection-tools");

export const CONNECTION_SEARCH_TOOL_NAME = "connection_search";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_SUGGESTIONS = 5;

const CONNECTION_SEARCH_DESCRIPTION = [
  "Find tools in your connected services (MCP servers and OpenAPI APIs).",
  "Returns each matching tool's connection, name, description, and TypeScript signature.",
  "Omit `query` to list a connection's tools. Call a found tool with connection_execute.",
  "Connections the user has not signed in to are listed under `unavailable` with `requiresSignIn`;",
  "when the request needs one, search it again with `connection` and `signIn: true` to ask the user to sign in.",
  "Prefer connected services over web search or general knowledge when a request relates to them.",
].join(" ");

const CONNECTION_EXECUTE_DESCRIPTION = [
  "Call one tool from a connected service and return its result.",
  "Use the exact `connection` and `tool` names returned by connection_search,",
  "and pass `input` matching the tool's signature.",
].join(" ");

const CONNECTION_SEARCH_INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Words describing the capability, such as 'list open issues'. Omit to list every tool.",
    },
    connection: { type: "string", description: "Only search this connection." },
    signIn: {
      type: "boolean",
      description:
        "Ask the user to sign in to `connection` first, then search it. Requires `connection`. Use only for a connection listed with `requiresSignIn` that the request needs.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: `Maximum results. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
    },
    offset: { type: "integer", minimum: 0, description: "Results to skip, for paging." },
  },
  additionalProperties: false,
};

const CONNECTION_EXECUTE_INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    connection: { type: "string", description: "Connection name from connection_search." },
    tool: { type: "string", description: "Tool name from connection_search." },
    input: {
      type: "object",
      description: "Arguments matching the tool's signature. Defaults to {}.",
    },
  },
  required: ["connection", "tool"],
  additionalProperties: false,
};

interface ConnectionSearchInput {
  readonly connection?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly query?: string;
  readonly signIn?: boolean;
}

interface ConnectionSearchMatch {
  readonly connection: string;
  readonly description: string;
  readonly signature: string;
  readonly tool: string;
}

interface UnavailableConnection {
  readonly connection: string;
  readonly error: string;
  /** Present when `signIn: true` can make the connection available. */
  readonly requiresSignIn?: true;
  /** Whether the failure is final rather than waiting on authorization. */
  readonly terminal: boolean;
}

interface ConnectionSearchOutput {
  readonly tools: readonly ConnectionSearchMatch[];
  /** Matches across all pages. */
  readonly total: number;
  readonly unavailable?: readonly Omit<UnavailableConnection, "terminal">[];
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Builds both tools for the current step, or `null` when the agent has no connections. */
export function resolveConnectionTools(): DynamicToolSet | null {
  const registry = loadContext().get(ConnectionRegistryKey);
  if (registry === undefined) return null;

  const approvals = registry
    .getConnections()
    .map((connection) => registry.getConnectionApproval(connection.connectionName))
    .filter((approval): approval is Approval => approval !== undefined);

  return {
    [CONNECTION_SEARCH_TOOL_NAME]: defineTool({
      description: CONNECTION_SEARCH_DESCRIPTION,
      inputSchema: CONNECTION_SEARCH_INPUT_SCHEMA,
      execute: defineDurableCallback({ callback: searchConnectionTools, closure: {} }),
      label: {
        start: defineDurableCallback({ callback: connectionSearchLabel, closure: {} }),
      },
    }),
    [CONNECTION_EXECUTE_TOOL_NAME]: defineTool({
      description: CONNECTION_EXECUTE_DESCRIPTION,
      inputSchema: CONNECTION_EXECUTE_INPUT_SCHEMA,
      execute: defineDurableCallback({ callback: executeConnectionTool, closure: {} }),
      label: {
        start: defineDurableCallback({ callback: connectionToolLabel, closure: {} }),
      },
      toModelOutput: defineDurableCallback({
        callback: (_closure: object, output: unknown) => connectionToolModelOutput(output),
        closure: {},
      }),
      ...connectionExecuteApproval(approvals),
    }),
  };
}

function connectionToolLabel(_closure: object, input: unknown): string {
  return toolCallDisplayName(CONNECTION_EXECUTE_TOOL_NAME, input);
}

function connectionSearchLabel(_closure: object, input: unknown): string {
  const connection = isObject(input) ? input.connection : undefined;
  if (typeof connection !== "string" || connection === "") return "Search connected tools";
  return isObject(input) && input.signIn === true
    ? `Connect ${displayProperName(connection)}`
    : `Search ${displayProperName(connection)} tools`;
}

// ---------------------------------------------------------------------------
// connection_search
// ---------------------------------------------------------------------------

async function searchConnectionTools(
  _closure: object,
  rawInput: unknown,
): Promise<ConnectionSearchOutput | AuthorizationSignal> {
  const input = (isObject(rawInput) ? rawInput : {}) as ConnectionSearchInput;
  const registry = requireRegistry();
  const connectionName =
    input.connection === undefined || input.connection === "" ? undefined : input.connection;
  if (input.signIn === true && connectionName === undefined) {
    throw new Error(
      "connection_search with signIn: true requires `connection`. Ask the user to sign in to one connection at a time.",
    );
  }
  const targets =
    connectionName === undefined
      ? registry.getConnections()
      : [requireConnection(registry, connectionName)];

  // Finishing a sign-in the user already completed never prompts. Starting one
  // is reserved for `signIn: true` on one named connection and connection_execute.
  const auth = createAuthorizationExecution();
  await completePendingAuthorizations(registry, targets, auth);

  const unavailable: UnavailableConnection[] = [];
  const candidates: RankCandidate[] = [];
  for (const connection of targets) {
    const listed = await listConnectionTools(registry, connection, auth, input.signIn === true);
    if ("signIn" in listed) return listed.signIn;
    if ("unavailable" in listed) unavailable.push(listed.unavailable);
    else {
      for (const tool of listed.tools) candidates.push({ connection, tool });
    }
  }

  const terminal = unavailable.filter((entry) => entry.terminal);
  if (targets.length > 0 && terminal.length === targets.length) {
    throw new Error(terminal.map((entry) => entry.error).join("\n"));
  }

  const ranked = rankConnectionTools(input.query ?? "", candidates);
  const limit = clampInteger(input.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);

  const output: { -readonly [K in keyof ConnectionSearchOutput]: ConnectionSearchOutput[K] } = {
    tools: ranked.slice(offset, offset + limit).map(({ connection, tool }) => ({
      connection: connection.connectionName,
      description: tool.description,
      signature: renderToolSignature({
        inputSchema: tool.inputSchema,
        name: tool.name,
        outputSchema: tool.outputSchema,
      }),
      tool: tool.name,
    })),
    total: ranked.length,
  };
  if (unavailable.length > 0) {
    output.unavailable = unavailable.map(({ terminal: _terminal, ...entry }) => entry);
  }
  return output;
}

type ListedConnectionTools =
  | { readonly tools: readonly ConnectionToolMetadata[] }
  | { readonly signIn: AuthorizationSignal }
  | { readonly unavailable: UnavailableConnection };

/** Lists a connection's tools, starting its sign-in instead when `signIn` asks for it. */
async function listConnectionTools(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  auth: ReturnType<typeof createAuthorizationExecution>,
  signIn: boolean,
): Promise<ListedConnectionTools> {
  const name = connection.connectionName;
  try {
    return { tools: await registry.getClient(name).getToolMetadata() };
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) {
      const scoped = await resolveInteractiveAuthorization(registry, name);
      // The token the user just signed in with was refused. Asking again would
      // loop, so report the failure instead.
      if (scoped !== undefined && auth.isJustAuthorized(scoped)) {
        return {
          unavailable: {
            connection: name,
            error: `Authorization failed for "${name}": the service rejected the token immediately after authorization.`,
            terminal: true,
          },
        };
      }
      if (scoped === undefined) {
        const cannotSignIn = `"${name}" requires authorization and cannot start interactive sign-in.`;
        if (signIn) throw new Error(cannotSignIn);
        return { unavailable: { connection: name, error: cannotSignIn, terminal: false } };
      }
      if (signIn) return { signIn: await auth.handleError(error, scoped) };
      return {
        unavailable: {
          connection: name,
          error:
            `Sign-in required: the user has not signed in to "${name}", so its tools cannot be listed. ` +
            `If the request needs "${name}", call connection_search with connection "${name}" and signIn: true to ask the user to sign in.`,
          requiresSignIn: true,
          terminal: false,
        },
      };
    }
    log.warn("failed to load connection tools", { connection: name, error });
    return {
      unavailable: {
        connection: name,
        error: isConnectionAuthorizationFailedError(error)
          ? `Authorization failed for "${name}": ${error.message}`
          : `Failed to load tools for "${name}": ${toErrorMessage(error)}`,
        terminal: true,
      },
    };
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// connection_execute
// ---------------------------------------------------------------------------

async function executeConnectionTool(
  _closure: object,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const target = readExecuteTarget(rawInput);
  if (target === undefined) {
    throw new Error("connection_execute requires string `connection` and `tool` values.");
  }
  const registry = requireRegistry();
  const connection = requireConnection(registry, target.connection);
  assertPendingAuthorizationInstances(registry, [connection]);

  const scoped = await resolveInteractiveAuthorization(registry, connection.connectionName);
  const auth = createAuthorizationExecution();
  if (scoped !== undefined) await auth.complete(scoped);
  const client = registry.getClient(connection.connectionName);

  let tools: readonly ConnectionToolMetadata[];
  try {
    tools = await client.getToolMetadata();
  } catch (error) {
    return await auth.handleError(error, scoped);
  }
  const tool = tools.find((entry) => entry.name === target.tool);
  if (tool === undefined) throw new Error(unknownToolMessage(connection, target.tool, tools));
  const input = await validToolInput(connection, tool, target.input);

  const toolName = qualifiedToolName(target);
  let raw: unknown;
  try {
    raw = await client.executeTool(tool.name, input, {
      abortSignal: ctx.abortSignal,
      callId: ctx.callId,
    });
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) return await auth.handleError(error, scoped);
    reportNestedToolAction(ctx.callId, {
      input,
      isError: true,
      output: toErrorMessage(error),
      toolName,
    });
    throw error;
  }

  const result = toConnectionToolResult(connection.protocol, tool, raw);
  if (!result.ok) {
    reportNestedToolAction(ctx.callId, {
      input,
      isError: true,
      output: result.error,
      toolName,
    });
    throw new Error(result.error);
  }
  reportNestedToolAction(ctx.callId, { input, output: result.value, toolName });
  return result.value;
}

/** Validates `input` against the tool's schema, returning it with schema defaults filled in. */
async function validToolInput(
  connection: ResolvedConnectionDefinition,
  tool: ConnectionToolMetadata,
  input: JsonObject,
): Promise<JsonObject> {
  const result = await defineJsonSchema(tool.inputSchema as JsonObject)["~standard"].validate(
    input,
  );
  if (result.issues === undefined) return result.value as JsonObject;
  const issues = result.issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
        .join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
  throw new Error(
    `Invalid input for "${tool.name}" on connection "${connection.connectionName}": ${issues}. ` +
      `Signature: ${renderToolSignature({ inputSchema: tool.inputSchema, name: tool.name, outputSchema: tool.outputSchema })}`,
  );
}

function unknownToolMessage(
  connection: ResolvedConnectionDefinition,
  toolName: string,
  tools: readonly ConnectionToolMetadata[],
): string {
  const suggestions = closestToolNames(toolName, tools, MAX_SUGGESTIONS);
  const hint =
    suggestions.length > 0
      ? ` Closest tools: ${suggestions.join(", ")}.`
      : " Use connection_search to find its tools.";
  return `Connection "${connection.connectionName}" has no tool named "${toolName}".${hint}`;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

async function resolveInteractiveAuthorization(
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
async function completePendingAuthorizations(
  registry: ConnectionRegistry,
  connections: readonly ResolvedConnectionDefinition[],
  auth: ReturnType<typeof createAuthorizationExecution>,
): Promise<void> {
  assertPendingAuthorizationInstances(registry, connections);
  const results = getAuthorizationResults();
  for (const connection of connections) {
    if (!results.some((result) => result.name === connection.connectionName)) continue;
    const scoped = await resolveInteractiveAuthorization(registry, connection.connectionName);
    if (scoped !== undefined) await auth.complete(scoped);
  }
}

/** Rejects sign-in results for the targeted connections whose instance changed while pending. */
function assertPendingAuthorizationInstances(
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

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function requireRegistry(): ConnectionRegistry {
  const registry = loadContext().get(ConnectionRegistryKey);
  if (registry === undefined) throw new Error("This agent has no connections.");
  return registry;
}

function requireConnection(
  registry: ConnectionRegistry,
  name: string,
): ResolvedConnectionDefinition {
  const connection = findConnection(registry, name);
  if (connection !== undefined) return connection;
  const available = registry.getConnectionNames();
  throw new Error(
    available.length === 0
      ? `Connection "${name}" is not available. No connections are available right now.`
      : `Connection "${name}" is not available. Available connections: ${available.join(", ")}.`,
  );
}
