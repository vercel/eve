import { createMCPClient, type MCPClient } from "#compiled/@ai-sdk/mcp/index.js";
import type { ToolSet } from "ai";

import { ConnectionAuthorizationRequiredError } from "#public/connections/errors.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { evictScopedToken, resolveScopedToken } from "#runtime/connections/scoped-authorization.js";
import { isObject } from "#shared/guards.js";
import type {
  ConnectionClient,
  ConnectionToolMetadata,
  HeadersDefinition,
  HeaderValue,
  ToolFilterDefinition,
} from "#runtime/connections/types.js";

interface McpToolCache {
  readonly metadata: readonly ConnectionToolMetadata[];
  readonly tools: ToolSet;
}

/**
 * Wraps one `MCPClient` from `@ai-sdk/mcp` for a single connection.
 *
 * Created lazily per-connection per-session. Caches tool metadata after
 * the first `getToolMetadata()` call.
 */
export class McpConnectionClient implements ConnectionClient {
  #clientPromise: Promise<MCPClient> | undefined;
  #client: MCPClient | undefined;
  #toolsPromise: Promise<McpToolCache> | undefined;
  #tools: McpToolCache | undefined;
  #connection: ResolvedConnectionDefinition;

  constructor(connection: ResolvedConnectionDefinition) {
    this.#connection = connection;
  }

  /**
   * Connects to the MCP server, trying Streamable HTTP first and
   * falling back to SSE for transport-compatibility failures.
   *
   * Concurrent callers share the same connection promise to avoid
   * duplicate connections.
   */
  async connect(): Promise<MCPClient> {
    if (this.#client !== undefined) {
      return this.#client;
    }

    if (this.#clientPromise !== undefined) {
      return this.#clientPromise;
    }

    this.#clientPromise = this.#createClient();
    try {
      this.#client = await this.#clientPromise;
      return this.#client;
    } catch (error) {
      this.#clientPromise = undefined;
      throw error;
    }
  }

  async #createClient(): Promise<MCPClient> {
    const headers = await resolveHeaders(this.#connection);
    const url = this.#connection.url;

    try {
      return await createMCPClient({
        transport: { type: "http", url, headers },
      });
    } catch (error) {
      if (!isMcpHttpFallbackRetryableError(error)) {
        throw error;
      }
      return await createMCPClient({
        transport: { type: "sse", url, headers },
      });
    }
  }

  /**
   * Returns cached tool metadata for all tools this connection exposes,
   * after applying any configured tool filter.
   *
   * The first call fetches tools from the server via `listTools()` and
   * creates the AI SDK tool set in parallel. Subsequent calls return
   * the cached result. Concurrent callers share the same in-flight
   * promise.
   */
  async getToolMetadata(): Promise<readonly ConnectionToolMetadata[]> {
    const cache = await this.#ensureTools();
    return cache.metadata;
  }

  /**
   * Returns the AI SDK `ToolSet` produced by `@ai-sdk/mcp`'s
   * `toolsFromDefinitions()`. Each entry is a full SDK `Tool` with
   * `inputSchema`, `description`, and `execute` already set.
   */
  async getTools(): Promise<ToolSet> {
    const cache = await this.#ensureTools();
    return cache.tools;
  }

  /**
   * Executes a named tool through the AI SDK's tool executor, which
   * handles the JSON-RPC `tools/call` internally.
   *
   * A `401`/`invalid_token` from the remote server is translated into
   * {@link ConnectionAuthorizationRequiredError} via {@link #rethrowClassified}
   * so callers re-enter the authorization flow instead of surfacing an
   * opaque transport error.
   */
  async executeTool(toolName: string, args: unknown): Promise<unknown> {
    try {
      const { tools } = await this.#ensureTools();

      const sdkTool = tools[toolName];
      if (sdkTool?.execute === undefined) {
        throw new Error(
          `Tool "${toolName}" not found in connection "${this.#connection.connectionName}".`,
        );
      }

      return await sdkTool.execute(args, {} as never);
    } catch (error) {
      return await this.#rethrowClassified(error);
    }
  }

  async #ensureTools(): Promise<McpToolCache> {
    if (this.#tools !== undefined) {
      return this.#tools;
    }

    if (this.#toolsPromise !== undefined) {
      return this.#toolsPromise;
    }

    this.#toolsPromise = this.#fetchTools();
    try {
      this.#tools = await this.#toolsPromise;
      return this.#tools;
    } catch (error) {
      this.#toolsPromise = undefined;
      throw error;
    }
  }

  async #fetchTools(): Promise<McpToolCache> {
    try {
      return await this.#fetchToolsInner();
    } catch (error) {
      return await this.#rethrowClassified(error);
    }
  }

  async #fetchToolsInner(): Promise<McpToolCache> {
    const client = await this.connect();
    const listResult = await client.listTools();

    const filter = this.#connection.tools;
    const filteredTools =
      filter !== undefined
        ? listResult.tools.filter((t) => passesToolFilter(t.name, filter))
        : listResult.tools;

    // `toolsFromDefinitions` returns `McpToolSet<"automatic">`, whose
    // elements are `Tool<unknown, CallToolResult>`. The AI SDK's
    // `ToolSet` constraint only admits `Tool<any | never, any | never>`,
    // so a single-hop cast is required — the runtime shape is identical.
    const tools = client.toolsFromDefinitions({ tools: filteredTools }) as ToolSet;

    const metadata: ConnectionToolMetadata[] = filteredTools.map((t) => ({
      annotations: t.annotations as Record<string, unknown> | undefined,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      name: t.name,
      outputSchema:
        "outputSchema" in t && t.outputSchema !== undefined
          ? (t.outputSchema as Record<string, unknown>)
          : undefined,
    }));

    return { metadata, tools };
  }

  async close(): Promise<void> {
    if (this.#client !== undefined) {
      await this.#client.close();
      this.#client = undefined;
    }
    this.#clientPromise = undefined;
    this.#toolsPromise = undefined;
    this.#tools = undefined;
  }

  /**
   * Always rethrows — this only classifies the error first. A non-auth
   * error (timeout, `5xx`, `403`, "tool not found", network failure) is
   * rethrown unchanged. Only a server rejection of the bearer
   * (`401`/`invalid_token`) is translated: evict the stale cached token,
   * tear down the connection so the retry reconnects with a fresh bearer,
   * and rethrow as {@link ConnectionAuthorizationRequiredError} so the
   * re-authorization flow takes over.
   */
  async #rethrowClassified(error: unknown): Promise<never> {
    if (!isMcpAuthRequiredError(error)) {
      throw error;
    }
    await this.#evictCachedToken();
    await this.close();
    throw new ConnectionAuthorizationRequiredError(this.#connection.connectionName, {
      message:
        `Connection "${this.#connection.connectionName}" requires authorization ` +
        `(the server rejected the token).`,
    });
  }

  /**
   * Best-effort removal of the rejected bearer for this connection's
   * resolved principal, across both eve's per-step cache and the
   * strategy's own cache (e.g. `@vercel/connect`). Delegates to the
   * shared {@link evictScopedToken} so MCP connections and authored
   * tools invalidate identically. No-op outside a runtime scope or when
   * the connection declares no authorization.
   */
  async #evictCachedToken(): Promise<void> {
    const authorization = this.#connection.authorization;
    if (authorization === undefined) return;
    await evictScopedToken({
      authorization,
      connection: { url: this.#connection.url },
      scope: this.#connection.connectionName,
    });
  }
}

/**
 * Returns `true` when an error from the MCP transport indicates the
 * bearer was rejected by the remote server — an HTTP `401`. Per
 * RFC 6750 a `401` means the access token is missing, expired, or
 * revoked, all of which are recoverable by re-authorizing. (A `403`
 * is an insufficient-scope / permission problem and is intentionally
 * left to propagate, since re-running the same grant would not help.)
 */
export function isMcpAuthRequiredError(error: unknown): boolean {
  return readHttpStatus(error) === 401;
}

/**
 * Decides whether an error thrown while creating a streamable HTTP MCP
 * client should trigger a fallback attempt against the legacy SSE
 * transport.
 *
 * Per the MCP backwards-compatibility rules, clients should fall back
 * to SSE when the streamable HTTP probe returns `400 Bad Request`,
 * `404 Not Found`, or `405 Method Not Allowed`. All other failures
 * (auth errors, network errors, server errors) should propagate so the
 * caller sees the real problem instead of a misleading SSE failure.
 *
 * See: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#backwards-compatibility
 */
function isMcpHttpFallbackRetryableError(error: unknown): boolean {
  const status = readHttpStatus(error);
  return status === 400 || status === 404 || status === 405;
}

function readHttpStatus(error: unknown): number | undefined {
  for (const candidate of walkErrorChain(error)) {
    if (!isObject(candidate)) {
      continue;
    }

    const status = readStatusField(candidate);
    if (status !== undefined) {
      return status;
    }

    const response = candidate.response;
    if (isObject(response)) {
      const responseStatus = readStatusField(response);
      if (responseStatus !== undefined) {
        return responseStatus;
      }
    }

    if (typeof candidate.message === "string") {
      const match = /\bHTTP\s+(\d{3})\b/u.exec(candidate.message);
      if (match?.[1] !== undefined) {
        return Number(match[1]);
      }
    }
  }

  return undefined;
}

function readStatusField(value: Record<string, unknown>): number | undefined {
  if (typeof value.status === "number") {
    return value.status;
  }
  if (typeof value.statusCode === "number") {
    return value.statusCode;
  }
  return undefined;
}

function* walkErrorChain(error: unknown): Generator<unknown> {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;

    if (!isObject(current) || !("cause" in current)) {
      return;
    }
    current = current.cause;
  }
}

/**
 * Returns `true` when a tool name passes the configured filter.
 */
export function passesToolFilter(
  toolName: string,
  filter: Readonly<ToolFilterDefinition> | undefined,
): boolean {
  if (filter === undefined) {
    return true;
  }
  if ("allow" in filter) {
    return filter.allow.includes(toolName);
  }
  return !filter.block.includes(toolName);
}

/**
 * Merges `authorization` (Bearer token) and `headers` into one
 * flat `Record<string, string>` for the transport layer.
 *
 * Resolves the {@link ConnectionPrincipal} from the active session
 * and invokes
 * `authorization.getToken({ principal })` to produce the bearer.
 * `getToken` may throw {@link ConnectionAuthorizationRequiredError};
 * callers (`connection_search`, wrapped connection tools) catch it
 * and it propagates as-is from here.
 */
export async function resolveHeaders(
  connection: ResolvedConnectionDefinition,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  if (connection.authorization !== undefined) {
    const result = await resolveToken(connection);
    merged.Authorization = `Bearer ${result.token}`;
  }

  if (connection.headers !== undefined) {
    const resolved = await resolveHeadersDefinition(connection.headers);
    for (const [key, value] of Object.entries(resolved)) {
      if (connection.authorization !== undefined && key.toLowerCase() === "authorization") {
        throw new Error(
          `Connection "${connection.connectionName}" headers must not include an "Authorization" key when "authorization" is also provided.`,
        );
      }
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Resolves a connection's bearer token via the shared scoped-token path,
 * keyed by the connection name. See
 * {@link resolveScopedToken} for the cache and principal semantics.
 */
async function resolveToken(connection: ResolvedConnectionDefinition) {
  if (connection.authorization === undefined) {
    throw new Error(`Connection "${connection.connectionName}" does not define authorization.`);
  }

  return await resolveScopedToken({
    authorization: connection.authorization,
    connection: { url: connection.url },
    scope: connection.connectionName,
  });
}

async function resolveHeadersDefinition(
  headers: Readonly<HeadersDefinition>,
): Promise<Record<string, string>> {
  if (typeof headers === "function") {
    return await headers();
  }

  const result: Record<string, string> = {};
  const entries = Object.entries(headers);

  for (const [key, value] of entries) {
    result[key] = await resolveHeaderValue(value);
  }

  return result;
}

async function resolveHeaderValue(value: HeaderValue): Promise<string> {
  if (typeof value === "function") {
    return await value();
  }
  return await value;
}
