import type { SessionAuthContext } from "#channel/types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpCallToolResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly name: string; readonly uri: string };

export interface McpServerTool {
  readonly definition: McpToolDefinition;
  call(
    input: unknown,
    context: { readonly auth: SessionAuthContext; readonly signal: AbortSignal },
  ): Promise<McpCallToolResult>;
}

export interface McpStreamableHttpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpServerTool[];
  authenticate(request: Request): Promise<SessionAuthContext | Response>;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

/**
 * Creates a stateless MCP Streamable HTTP request handler.
 *
 * The handler deliberately does not issue `Mcp-Session-Id`: all durable state
 * belongs to the invoked service, so reconnecting clients may use any server
 * instance. POST responses use the JSON response mode permitted by Streamable
 * HTTP and notifications receive 202 with no body.
 */
export function createMcpStreamableHttpServer(
  options: McpStreamableHttpServerOptions,
): (request: Request) => Promise<Response> {
  const tools = new Map(options.tools.map((tool) => [tool.definition.name, tool]));

  return async (request) => {
    if (request.method === "DELETE") {
      return jsonRpcHttpError(405, "This stateless MCP server has no transport session to delete.");
    }
    if (request.method !== "POST") {
      return new Response(null, { headers: { allow: "POST" }, status: 405 });
    }

    const auth = await options.authenticate(request);
    if (auth instanceof Response) return auth;

    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return jsonRpcResponse(errorResponse(null, -32700, "Parse error."), 400);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return jsonRpcResponse(errorResponse(null, -32600, "Invalid Request."), 400);
      }
      const responses = await Promise.all(
        value.map(async (entry) => await handleEntry(entry, auth, tools, options)),
      );
      const withBodies = responses.filter(
        (response): response is Record<string, unknown> => response !== null,
      );
      return withBodies.length === 0
        ? new Response(null, { status: 202 })
        : jsonRpcResponse(withBodies);
    }

    const response = await handleEntry(value, auth, tools, options);
    return response === null ? new Response(null, { status: 202 }) : jsonRpcResponse(response);
  };
}

async function handleEntry(
  value: unknown,
  auth: SessionAuthContext,
  tools: ReadonlyMap<string, McpServerTool>,
  options: Pick<McpStreamableHttpServerOptions, "name" | "version">,
): Promise<Record<string, unknown> | null> {
  const request = parseRequest(value);
  if (request === null) return errorResponse(readId(value), -32600, "Invalid Request.");

  const isNotification = request.id === undefined;
  if (
    request.method === "notifications/initialized" ||
    request.method === "notifications/cancelled"
  ) {
    return isNotification ? null : successResponse(request.id ?? null, {});
  }
  if (isNotification) return null;

  switch (request.method) {
    case "initialize":
      return successResponse(request.id ?? null, {
        capabilities: { tools: { listChanged: false } },
        protocolVersion: negotiateProtocolVersion(request.params),
        serverInfo: { name: options.name, version: options.version },
      });
    case "ping":
      return successResponse(request.id ?? null, {});
    case "tools/list":
      return successResponse(request.id ?? null, {
        tools: [...tools.values()].map((tool) => tool.definition),
      });
    case "tools/call":
      return await callTool(request, auth, tools);
    default:
      return errorResponse(request.id ?? null, -32601, "Method not found.");
  }
}

async function callTool(
  request: JsonRpcRequest,
  auth: SessionAuthContext,
  tools: ReadonlyMap<string, McpServerTool>,
): Promise<Record<string, unknown>> {
  const params = isRecord(request.params) ? request.params : undefined;
  const name = params?.name;
  if (typeof name !== "string") {
    return errorResponse(request.id ?? null, -32602, "tools/call requires a tool name.");
  }
  const tool = tools.get(name);
  if (tool === undefined) return errorResponse(request.id ?? null, -32602, `Unknown tool: ${name}`);

  try {
    const result = await tool.call(params?.arguments ?? {}, {
      auth,
      // Request cancellation is represented by MCP notifications on a separate
      // HTTP request, so it cannot reliably abort this stateless request. The
      // durable invocation cancellation tool is the reliability mechanism.
      signal: new AbortController().signal,
    });
    return successResponse(request.id ?? null, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool call failed.";
    return successResponse(request.id ?? null, {
      content: [{ type: "text", text: message }],
      isError: true,
    });
  }
}

function negotiateProtocolVersion(params: unknown): string {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  return requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION;
}

function parseRequest(value: unknown): JsonRpcRequest | null {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return null;
  if ("id" in value && !isJsonRpcId(value.id)) return null;
  return {
    id: "id" in value ? (value.id as JsonRpcId) : undefined,
    jsonrpc: "2.0",
    method: value.method,
    params: value.params,
  };
}

function readId(value: unknown): JsonRpcId {
  if (!isRecord(value) || !isJsonRpcId(value.id)) return null;
  return value.id;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function successResponse(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    status,
  });
}

function jsonRpcHttpError(status: number, message: string): Response {
  return jsonRpcResponse(errorResponse(null, -32600, message), status);
}
