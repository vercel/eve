/**
 * `connection_search` and `connection_execute`: fixed tools that reach every
 * connection tool without adding definitions to the model's tool list, so
 * discovery never changes the cached prompt prefix. Both are rebuilt each
 * step from the connection registry with identical model-facing definitions.
 */

import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalContext,
  type ApprovalResponseContext,
  type ApprovalResponseDecision,
  type ApprovalStatus,
} from "#approval/definition.js";
import {
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import {
  getAuthorizationResults,
  requestAuthorization,
  type AuthorizationChallenge,
  type AuthorizationSignal,
} from "#harness/authorization.js";
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
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import { defineDurableCallback } from "#tools/durable-callbacks.js";
import { defineTool, type ToolContext } from "#tools/definition.js";
import type { DynamicToolSet } from "#tools/dynamic.js";
import { defineJsonSchema } from "#tools/schema.js";

const log = createLogger("framework.connection-tools");

export const CONNECTION_SEARCH_TOOL_NAME = "connection_search";
export const CONNECTION_EXECUTE_TOOL_NAME = "connection_execute";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_SUGGESTIONS = 5;
/** Bounds the approval pins kept for calls that were never executed. */
const MAX_APPROVAL_PINS = 50;

const CONNECTION_SEARCH_DESCRIPTION = [
  "Find tools in your connected services (MCP servers and OpenAPI APIs).",
  "Returns each matching tool's connection, name, description, and TypeScript signature.",
  "Omit `query` to list a connection's tools. Call a found tool with connection_execute.",
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
}

interface ConnectionExecuteInput {
  readonly connection: string;
  readonly input?: JsonObject;
  readonly tool: string;
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
  /** Whether the failure is final rather than waiting on authorization. */
  readonly terminal: boolean;
}

interface ConnectionSearchOutput {
  readonly tools: readonly ConnectionSearchMatch[];
  /** Matches across all pages. */
  readonly total: number;
  readonly unavailable?: readonly Omit<UnavailableConnection, "terminal">[];
}

/**
 * Connection instance each approved `connection_execute` call was approved
 * against, keyed by call id. A call whose connection resolves to a different
 * instance by the time it runs is rejected rather than sent to it.
 */
const ConnectionApprovalPinsKey = new ContextKey<Readonly<Record<string, string>>>(
  "eve.connectionApprovalPins",
);

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

/**
 * Delegates approval to the called connection's policy. The request and
 * response phases exist only when some registered connection defines them,
 * so connections without a response policy keep the default response flow
 * unless another connection in the same agent defines one.
 */
function connectionExecuteApproval(approvals: readonly Approval[]) {
  if (approvals.length === 0) return {};
  const request = defineDurableCallback({ callback: requestConnectionApproval, closure: {} });
  const hasResponsePolicy = approvals.some(
    (approval) => typeof approval !== "function" && approval.response !== undefined,
  );
  return {
    approvalKey: defineDurableCallback({ callback: connectionApprovalKey, closure: {} }),
    approval: hasResponsePolicy
      ? {
          request,
          response: defineDurableCallback({
            callback: authorizeConnectionApprovalResponse,
            closure: {},
          }),
        }
      : request,
  };
}

function connectionToolLabel(_closure: object, input: unknown): string {
  const target = readExecuteTarget(input);
  return target === undefined ? CONNECTION_EXECUTE_TOOL_NAME : qualifiedToolName(target);
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
  const targets =
    input.connection === undefined || input.connection === ""
      ? registry.getConnections()
      : [requireConnection(registry, input.connection)];

  const auth = createAuthorizationExecution();
  await completePendingAuthorizations(registry, targets, auth);

  const challenges: AuthorizationChallenge[] = [];
  const unavailable: UnavailableConnection[] = [];
  const candidates: { readonly connection: string; readonly tool: ConnectionToolMetadata }[] = [];
  for (const connection of targets) {
    const listed = await listConnectionTools(registry, connection, auth);
    if ("challenges" in listed) challenges.push(...listed.challenges);
    else if ("unavailable" in listed) unavailable.push(listed.unavailable);
    else {
      for (const tool of listed.tools)
        candidates.push({ connection: connection.connectionName, tool });
    }
  }

  if (challenges.length > 0) return requestAuthorization(challenges);
  const terminal = unavailable.filter((entry) => entry.terminal);
  if (targets.length > 0 && terminal.length === targets.length) {
    throw new Error(terminal.map((entry) => entry.error).join("\n"));
  }

  const queryTokens = tokenize(input.query ?? "");
  const ranked = candidates
    .map((candidate) => ({ ...candidate, score: scoreTool(queryTokens, candidate.tool) }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.connection.localeCompare(b.connection) ||
        a.tool.name.localeCompare(b.tool.name),
    );
  const limit = clampInteger(input.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);

  const output: { -readonly [K in keyof ConnectionSearchOutput]: ConnectionSearchOutput[K] } = {
    tools: ranked.slice(offset, offset + limit).map(({ connection, tool }) => ({
      connection,
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
    output.unavailable = unavailable.map(({ connection, error }) => ({ connection, error }));
  }
  return output;
}

type ListedConnectionTools =
  | { readonly tools: readonly ConnectionToolMetadata[] }
  | { readonly challenges: readonly AuthorizationChallenge[] }
  | { readonly unavailable: UnavailableConnection };

async function listConnectionTools(
  registry: ConnectionRegistry,
  connection: ResolvedConnectionDefinition,
  auth: ReturnType<typeof createAuthorizationExecution>,
): Promise<ListedConnectionTools> {
  const name = connection.connectionName;
  try {
    return { tools: await registry.getClient(name).getToolMetadata() };
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) {
      const scoped = await resolveInteractiveAuthorization(registry, name);
      if (scoped === undefined) {
        return {
          unavailable: {
            connection: name,
            error: `"${name}" requires authorization and cannot start interactive sign-in.`,
            terminal: false,
          },
        };
      }
      try {
        return { challenges: (await auth.handleError(error, scoped)).challenges };
      } catch (startError) {
        log.warn("connection authorization failed", { connection: name, error: startError });
        return {
          unavailable: {
            connection: name,
            error: isConnectionAuthorizationFailedError(startError)
              ? startError.message
              : `Failed to start authorization for "${name}": ${toErrorMessage(startError)}`,
            terminal: true,
          },
        };
      }
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

function tokenize(text: string): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
}

/** Word overlap weighted by where the word appears. Every tool matches an empty query. */
function scoreTool(queryTokens: readonly string[], tool: ConnectionToolMetadata): number {
  if (queryTokens.length === 0) return 1;
  const properties = isObject(tool.inputSchema.properties)
    ? Object.keys(tool.inputSchema.properties)
    : [];
  const fields: readonly (readonly [readonly string[], number])[] = [
    [tokenize(tool.name), 3],
    [properties.flatMap(tokenize), 2],
    [tokenize(tool.description), 1],
  ];
  let score = 0;
  for (const query of queryTokens) {
    for (const [tokens, weight] of fields) {
      if (tokens.some((token) => matchesToken(token, query))) score += weight;
    }
  }
  return score;
}

function matchesToken(token: string, query: string): boolean {
  return token.startsWith(query) || (token.length >= 3 && query.startsWith(token));
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
  releaseApprovalPin(ctx.callId, connection);
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
  await assertValidToolInput(connection, tool, target.input);

  const toolName = qualifiedToolName(target);
  let raw: unknown;
  try {
    raw = await client.executeTool(tool.name, target.input, {
      abortSignal: ctx.abortSignal,
      callId: ctx.callId,
    });
  } catch (error) {
    if (isConnectionAuthorizationRequiredError(error)) return await auth.handleError(error, scoped);
    reportNestedToolAction(ctx.callId, {
      input: target.input,
      isError: true,
      output: toErrorMessage(error),
      toolName,
    });
    throw error;
  }

  const result = toConnectionToolResult(connection.protocol, tool, raw);
  if (!result.ok) {
    reportNestedToolAction(ctx.callId, {
      input: target.input,
      isError: true,
      output: result.error,
      toolName,
    });
    throw new Error(result.error);
  }
  reportNestedToolAction(ctx.callId, { input: target.input, output: result.value, toolName });
  return result.value;
}

async function assertValidToolInput(
  connection: ResolvedConnectionDefinition,
  tool: ConnectionToolMetadata,
  input: JsonObject,
): Promise<void> {
  const result = await defineJsonSchema(tool.inputSchema as JsonObject)["~standard"].validate(
    input,
  );
  if (result.issues === undefined) return;
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
  const queryTokens = tokenize(toolName);
  const suggestions = tools
    .map((tool) => ({ name: tool.name, score: scoreTool(queryTokens, tool) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.name);
  const hint =
    suggestions.length > 0
      ? ` Closest tools: ${suggestions.join(", ")}.`
      : " Use connection_search to find its tools.";
  return `Connection "${connection.connectionName}" has no tool named "${toolName}".${hint}`;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function connectionApprovalKey(_closure: object, input: unknown): string {
  const target = readExecuteTarget(input);
  return target === undefined ? CONNECTION_EXECUTE_TOOL_NAME : qualifiedToolName(target);
}

async function requestConnectionApproval(
  _closure: object,
  context: ApprovalContext,
): Promise<ApprovalStatus> {
  const target = readExecuteTarget(context.toolInput);
  const registry = loadContext().get(ConnectionRegistryKey);
  if (target === undefined || registry === undefined) return "not-applicable";
  const connection = findConnection(registry, target.connection);
  const approval =
    connection === undefined
      ? undefined
      : registry.getConnectionApproval(connection.connectionName);
  if (connection === undefined || approval === undefined) return "not-applicable";

  // The AI SDK re-runs this policy before executing an approved call, so an
  // existing pin must survive and a changed connection denies the call.
  if (!matchesApprovalPin(context.callId, connection)) {
    return { type: "denied", reason: CONNECTION_CHANGED_MESSAGE };
  }
  pinApprovedInstance(context.callId, connection);
  return await resolveApprovalPolicy(approval)({
    ...context,
    toolInput: target.input,
    toolName: qualifiedToolName(target),
  });
}

async function authorizeConnectionApprovalResponse(
  _closure: object,
  context: ApprovalResponseContext,
): Promise<ApprovalResponseDecision> {
  const target = readExecuteTarget(context.request.toolInput);
  const registry = loadContext().get(ConnectionRegistryKey);
  const connection =
    target === undefined || registry === undefined
      ? undefined
      : findConnection(registry, target.connection);
  if (target === undefined || registry === undefined || connection === undefined) {
    return { reason: "The connection for this tool call is unavailable.", status: "rejected" };
  }
  if (!matchesApprovalPin(context.request.callId, connection)) {
    return { reason: CONNECTION_CHANGED_MESSAGE, status: "rejected" };
  }
  const approval = registry.getConnectionApproval(connection.connectionName);
  const response =
    approval === undefined || typeof approval === "function" ? undefined : approval.response;
  if (response === undefined) return { status: "allowed" };
  return await response({
    ...context,
    request: {
      ...context.request,
      toolInput: target.input,
      toolName: qualifiedToolName(target),
    },
  });
}

const CONNECTION_CHANGED_MESSAGE =
  "The connection for this tool call changed or is unavailable. Request a new tool call and approval.";

/** Records the instance a call was first evaluated against; later evaluations keep it. */
function pinApprovedInstance(callId: string, connection: ResolvedConnectionDefinition): void {
  if (connection.instanceId === undefined) return;
  const instanceId = connection.instanceId;
  const ctx = loadContext();
  if (ctx.get(ConnectionApprovalPinsKey)?.[callId] !== undefined) return;
  ctx.set(ConnectionApprovalPinsKey, (pins = {}) =>
    Object.fromEntries([
      ...Object.entries(pins).slice(-(MAX_APPROVAL_PINS - 1)),
      [callId, instanceId],
    ]),
  );
}

function matchesApprovalPin(callId: string, connection: ResolvedConnectionDefinition): boolean {
  const pinned = loadContext().get(ConnectionApprovalPinsKey)?.[callId];
  return pinned === undefined || pinned === connection.instanceId;
}

/** Consumes the call's approval pin, rejecting the call if its connection changed. */
function releaseApprovalPin(callId: string, connection: ResolvedConnectionDefinition): void {
  const ctx = loadContext();
  const pins = ctx.get(ConnectionApprovalPinsKey);
  if (pins?.[callId] === undefined) return;
  const { [callId]: pinned, ...rest } = pins;
  ctx.set(ConnectionApprovalPinsKey, rest);
  if (pinned !== connection.instanceId) throw new Error(CONNECTION_CHANGED_MESSAGE);
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

interface ExecuteTarget {
  readonly connection: string;
  readonly input: JsonObject;
  readonly tool: string;
}

function readExecuteTarget(value: unknown): ExecuteTarget | undefined {
  if (!isObject(value)) return undefined;
  const { connection, input, tool } = value as Partial<ConnectionExecuteInput>;
  if (typeof connection !== "string" || typeof tool !== "string") return undefined;
  return { connection, input: isObject(input) ? (input as JsonObject) : {}, tool };
}

function qualifiedToolName(target: Pick<ExecuteTarget, "connection" | "tool">): string {
  return `${target.connection}__${target.tool}`;
}

function requireRegistry(): ConnectionRegistry {
  const registry = loadContext().get(ConnectionRegistryKey);
  if (registry === undefined) throw new Error("This agent has no connections.");
  return registry;
}

function findConnection(
  registry: ConnectionRegistry,
  name: string,
): ResolvedConnectionDefinition | undefined {
  return registry.getConnections().find((connection) => connection.connectionName === name);
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
