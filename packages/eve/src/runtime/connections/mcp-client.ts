import { ConnectionEventActions, isEventAction } from "#runtime/subscriptions/actions.js";
import { createMCPClient, type MCPClient } from "#compiled/@ai-sdk/mcp/index.js";
import type { ToolSet } from "ai";

import {
  ConnectionAuthorizationRequiredError,
  isConnectionAuthorizationRequiredError,
} from "#connections/errors.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { evictScopedToken, resolveScopedToken } from "#runtime/connections/scoped-authorization.js";
import { resolveConnectionAuthorization } from "#runtime/connections/resolve-authorization.js";
import { buildConnectionCallbackContext } from "#runtime/connections/approval-scope.js";
import { isObject } from "#shared/guards.js";
import { readTurnPrincipals } from "#context/turn-principals.js";
import {
  encodeForwardedPrincipalHeader,
  FORWARDED_PRINCIPAL_HEADER,
} from "#internal/mcp/forwarded-principal-header.js";
import {
  omitProvidedArgumentsFromSchema,
  resolveProvidedArguments,
} from "#runtime/connections/provided-arguments.js";
import {
  createMcpTraceFetch,
  withMcpToolCallSpan,
  withMcpToolsListSpan,
} from "#runtime/connections/mcp-tracing.js";
import type {
  AuthorizationDefinition,
  ConnectionCallbackContext,
  ConnectionClient,
  ConnectionToolExecuteOptions,
  ConnectionToolMetadata,
  HeadersDefinition,
  HeaderValue,
  ToolFilterDefinition,
} from "#shared/connection-types.js";

interface McpToolCache {
  readonly metadata: readonly ConnectionToolMetadata[];
  readonly tools: ToolSet;
}

class McpUnauthorizedError extends Error {
  readonly statusCode = 401;
  readonly anonymous: boolean;

  constructor(anonymous: boolean) {
    super("MCP HTTP request failed (HTTP 401).");
    this.anonymous = anonymous;
  }
}

async function checkAuthorizationResponse(
  response: Response,
  anonymous: boolean,
): Promise<Response> {
  if (response.status === 401) {
    await response.body?.cancel();
    throw new McpUnauthorizedError(anonymous);
  }
  return response;
}

export class McpConnectionClient implements ConnectionClient {
  #clientPromise: Promise<MCPClient> | undefined;
  #client: MCPClient | undefined;
  #toolsPromise: Promise<McpToolCache> | undefined;
  #tools: McpToolCache | undefined;
  #connection: ResolvedConnectionDefinition;
  readonly eventActions: ConnectionClient["eventActions"];

  constructor(connection: ResolvedConnectionDefinition) {
    this.#connection = connection;
    if (connection.experimental_events !== undefined) {
      const events = new ConnectionEventActions(
        connection,
        connection.experimental_events,
        () => resolveHeaders(connection),
        this.#forwardingFetch(),
      );
      this.eventActions = {
        ownsName: isEventAction,
        metadata: async () => {
          try {
            return await events.metadata();
          } catch (error) {
            return await this.#rethrowClassified(error);
          }
        },
        execute: async (name, args, options) => {
          try {
            return await events.execute(name, args, options);
          } catch (error) {
            return await this.#rethrowClassified(error);
          }
        },
      };
    }
  }

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
    const { headers } = await resolveConnectionHeaders(this.#connection, {
      anonymousWhenAuthorizationRequired: true,
    });
    const url = this.#connection.url;
    const fetch = createMcpTraceFetch({
      connectionName: this.#connection.connectionName,
      fetcher: this.#authorizedFetch(Object.keys(headers)),
      getProtocolVersion: () => this.#client?.initializeResult?.protocolVersion,
    });

    try {
      return await createMCPClient({
        protocolVersionDiscovery: this.#connection.protocolVersionDiscovery,
        transport: { fetch, headers, type: "http", url },
      });
    } catch (error) {
      if (!isMcpHttpFallbackRetryableError(error)) {
        throw error;
      }
      return await createMCPClient({
        protocolVersionDiscovery: this.#connection.protocolVersionDiscovery,
        transport: { fetch, headers, type: "sse", url },
      });
    }
  }

  #authorizedFetch(connectionHeaderNames: readonly string[]): typeof fetch {
    const fetcher = this.#forwardingFetch() ?? globalThis.fetch;
    return async (request, init) => {
      const resolve = () =>
        resolveConnectionHeaders(this.#connection, { anonymousWhenAuthorizationRequired: true });
      const send = async (resolved: ResolvedConnectionHeaders) => {
        const headers = new Headers(init?.headers);
        for (const name of connectionHeaderNames) headers.delete(name);
        for (const [name, value] of Object.entries(resolved.headers)) headers.set(name, value);
        return await fetcher(request, { ...init, headers });
      };

      const resolved = await resolve();
      const response = await send(resolved);
      if (
        response.status !== 401 ||
        resolved.anonymous ||
        this.#connection.authorization === undefined ||
        init?.signal?.aborted
      ) {
        return await checkAuthorizationResponse(response, resolved.anonymous);
      }

      await this.#evictCachedToken();
      const refreshed = await resolve();
      if (refreshed.anonymous) {
        return await checkAuthorizationResponse(response, true);
      }
      await response.body?.cancel();
      return await checkAuthorizationResponse(await send(refreshed), refreshed.anonymous);
    };
  }

  #forwardingFetch(): typeof fetch | undefined {
    if (this.#connection.forwardPrincipal !== true) return undefined;
    const connectionName = this.#connection.connectionName;
    return async (request, init) => {
      const principals = readTurnPrincipals();
      if (principals === undefined) return await globalThis.fetch(request, init);
      const headers = new Headers(init?.headers);
      headers.set(
        FORWARDED_PRINCIPAL_HEADER,
        encodeForwardedPrincipalHeader(principals, connectionName),
      );
      return await globalThis.fetch(request, { ...init, headers, redirect: "error" });
    };
  }

  async getToolMetadata(): Promise<readonly ConnectionToolMetadata[]> {
    return (await this.#ensureTools()).metadata;
  }

  async executeTool(
    toolName: string,
    args: unknown,
    options: ConnectionToolExecuteOptions,
  ): Promise<unknown> {
    let result: unknown;
    try {
      const { tools } = await this.#ensureTools();

      const sdkTool = tools[toolName];
      if (sdkTool?.execute === undefined) {
        throw new Error(
          `Tool "${toolName}" not found in connection "${this.#connection.connectionName}".`,
        );
      }
      const execute = sdkTool.execute;

      const resolvedArgs = await resolveProvidedArguments({
        args,
        callId: options.callId,
        connection: this.#connection,
        toolName,
      });

      result = await withMcpToolCallSpan({
        arguments: args,
        connectionName: this.#connection.connectionName,
        execute: async () =>
          await execute(resolvedArgs, { abortSignal: options.abortSignal } as never),
        protocolVersion: this.#client?.initializeResult?.protocolVersion,
        toolName,
      });
    } catch (error) {
      return await this.#rethrowClassified(error);
    }
    if (isMcpAuthChallengeResult(result)) {
      return await this.#requireAuthorization(`the server asked for sign-in to call "${toolName}"`);
    }
    return result;
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
    const listResult = await withMcpToolsListSpan({
      connectionName: this.#connection.connectionName,
      execute: () => client.listTools(),
      protocolVersion: client.initializeResult?.protocolVersion,
    });

    const providedArgumentNames = Object.keys(this.#connection.toolCall?.providedArguments ?? {});
    const projectedTools = listResult.tools.map((tool) => ({
      ...tool,
      inputSchema: omitProvidedArgumentsFromSchema(tool.inputSchema, providedArgumentNames),
    }));

    const tools = client.toolsFromDefinitions({ tools: projectedTools }) as ToolSet;

    const metadata: ConnectionToolMetadata[] = projectedTools.map((t) => ({
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

  async #rethrowClassified(error: unknown): Promise<never> {
    if (!isMcpAuthRequiredError(error)) {
      throw error;
    }
    const requestError = [...walkErrorChain(error)].find(
      (candidate) => candidate instanceof McpUnauthorizedError,
    );
    const anonymous =
      requestError?.anonymous ??
      (
        await resolveConnectionHeaders(this.#connection, {
          anonymousWhenAuthorizationRequired: true,
        })
      ).anonymous;
    return await this.#requireAuthorization(
      anonymous ? "the server requires sign-in" : "the server rejected the token",
      anonymous,
    );
  }

  async #requireAuthorization(reason: string, anonymous?: boolean): Promise<never> {
    anonymous ??= (
      await resolveConnectionHeaders(this.#connection, { anonymousWhenAuthorizationRequired: true })
    ).anonymous;
    if (!anonymous) {
      await this.#evictCachedToken();
    }
    await this.close();
    throw new ConnectionAuthorizationRequiredError(this.#connection.connectionName, {
      message: `Connection "${this.#connection.connectionName}" requires authorization (${reason}).`,
    });
  }

  async #evictCachedToken(): Promise<void> {
    const authorization = await resolveConnectionAuthorization(this.#connection);
    if (authorization === undefined) return;
    await evictScopedToken({
      authorization,
      connection: { url: this.#connection.url },
      instanceId: this.#connection.instanceId,
      scope: this.#connection.connectionName,
    });
  }
}

export function isMcpAuthRequiredError(error: unknown): boolean {
  return readHttpStatus(error) === 401;
}

export const MCP_WWW_AUTHENTICATE_META_KEY = "mcp/www_authenticate";

export function isMcpAuthChallengeResult(result: unknown): boolean {
  if (!isObject(result) || result.isError !== true || !isObject(result._meta)) {
    return false;
  }
  const challenge = result._meta[MCP_WWW_AUTHENTICATE_META_KEY];
  if (typeof challenge === "string") return challenge.length > 0;
  return Array.isArray(challenge) && challenge.length > 0;
}

function isMcpHttpFallbackRetryableError(error: unknown): boolean {
  const status = readHttpStatus(error);
  return status === 400 || status === 404 || status === 405;
}

export function readHttpStatus(error: unknown): number | undefined {
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

export function passesToolFilter(
  names: readonly string[],
  filter: Readonly<ToolFilterDefinition> | undefined,
): boolean {
  if (filter === undefined) {
    return true;
  }
  if ("allow" in filter) {
    return names.some((name) => filter.allow.includes(name));
  }
  return !names.some((name) => filter.block.includes(name));
}

export async function resolveHeaders(
  connection: ResolvedConnectionDefinition,
): Promise<Record<string, string>> {
  const { headers } = await resolveConnectionHeaders(connection, {
    anonymousWhenAuthorizationRequired: false,
  });
  return headers;
}

interface ResolvedConnectionHeaders {
  readonly anonymous: boolean;
  readonly headers: Record<string, string>;
}

async function resolveConnectionHeaders(
  connection: ResolvedConnectionDefinition,
  options: { readonly anonymousWhenAuthorizationRequired: boolean },
): Promise<ResolvedConnectionHeaders> {
  const merged: Record<string, string> = {};
  let anonymous = false;
  const authorization = await resolveConnectionAuthorization(connection);

  if (authorization !== undefined) {
    try {
      const result = await resolveToken(connection, authorization);
      merged.Authorization = `Bearer ${result.token}`;
    } catch (error) {
      if (
        !options.anonymousWhenAuthorizationRequired ||
        !isConnectionAuthorizationRequiredError(error)
      ) {
        throw error;
      }
      anonymous = true;
    }
  }

  if (connection.headers !== undefined) {
    let context: ConnectionCallbackContext | undefined;
    const resolved = await resolveHeadersDefinition(
      connection.headers,
      () => (context ??= buildConnectionCallbackContext()),
    );
    for (const [key, value] of Object.entries(resolved)) {
      if (authorization !== undefined && key.toLowerCase() === "authorization") {
        throw new Error(
          `Connection "${connection.connectionName}" headers must not include an "Authorization" key when "authorization" is also provided.`,
        );
      }
      merged[key] = value;
    }
  }

  return { anonymous, headers: merged };
}

async function resolveToken(
  connection: ResolvedConnectionDefinition,
  authorization: Readonly<AuthorizationDefinition>,
) {
  return await resolveScopedToken({
    authorization,
    connection: { url: connection.url },
    instanceId: connection.instanceId,
    scope: connection.connectionName,
  });
}

async function resolveHeadersDefinition(
  headers: Readonly<HeadersDefinition>,
  getContext: () => ConnectionCallbackContext,
): Promise<Record<string, string>> {
  if (typeof headers === "function") {
    return { ...(await headers(getContext())) };
  }

  const result: Record<string, string> = {};
  const entries = Object.entries(headers);

  for (const [key, value] of entries) {
    result[key] = await resolveHeaderValue(value, getContext);
  }

  return result;
}

async function resolveHeaderValue(
  value: HeaderValue,
  getContext: () => ConnectionCallbackContext,
): Promise<string> {
  if (typeof value === "function") {
    return await value(getContext());
  }
  return await value;
}
