import { defineMcpHandler, type McpToolAnnotations } from "#compiled/h3-mcp/index.js";
import type { z } from "#compiled/zod/index.js";

import type { SessionAuthContext } from "#channel/types.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const MCP_LEGACY_PROTOCOL_VERSIONS = new Set([
  MCP_LEGACY_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
]);
const MCP_MAX_BODY_SIZE_BYTES = 4 * 1024 * 1024;

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly annotations?: McpToolAnnotations;
  readonly inputSchema: z.ZodType;
  readonly outputSchema?: z.ZodType;
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
    context: { readonly auth: SessionAuthContext | null; readonly signal: AbortSignal },
  ): Promise<McpCallToolResult>;
}

export interface McpStreamableHttpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpServerTool[];
  authenticate(request: Request): Promise<SessionAuthContext | null | Response>;
}

/** Creates a dual-era, stateless MCP HTTP request handler. */
export function createMcpStreamableHttpServer(
  options: McpStreamableHttpServerOptions,
): (request: Request) => Promise<Response> {
  const tools = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  if (tools.size !== options.tools.length) throw new Error("MCP tool names must be unique.");

  return async (request) => {
    const auth = await options.authenticate(request);
    if (auth instanceof Response) return auth;

    const preflight = await preflightRequest(request);
    if (preflight.response !== undefined) return preflight.response;

    const handler = defineMcpHandler({
      era: preflight.modern ? "modern" : "dual",
      name: options.name,
      origin: false,
      tools: [...tools.values()].map((tool) => ({
        ...tool.definition,
        handler: async (input, event) => await callTool(tool, input, event.req.signal, auth),
      })),
      version: options.version,
    });
    return await handler.fetch(request);
  };
}

interface McpRequestPreflight {
  readonly modern: boolean;
  readonly response?: Response;
}

async function preflightRequest(request: Request): Promise<McpRequestPreflight> {
  const protocolHeader = request.headers.get("mcp-protocol-version");
  const modernHeader = protocolHeader !== null && !MCP_LEGACY_PROTOCOL_VERSIONS.has(protocolHeader);
  if (request.method.toUpperCase() !== "POST") return { modern: modernHeader };

  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return { modern: modernHeader, response: jsonRpcError(null, -32_000, "Not Acceptable", 406) };
  }

  const method = request.headers.get("mcp-method");
  if (
    modernHeader &&
    method !== null &&
    ["completion/", "prompts/", "resources/"].some((prefix) => method.startsWith(prefix))
  ) {
    const body = await readRequestBody(request);
    if (body.tooLarge) return { modern: true, response: requestBodyTooLargeResponse() };
    if (readJsonRpcRequestMethod(body.value) === method) {
      return {
        modern: true,
        response: jsonRpcError(readJsonRpcRequestId(body.value), -32_601, "Method not found", 404),
      };
    }
  }

  if (protocolHeader !== null) return { modern: modernHeader };

  const body = await readRequestBody(request);
  if (body.tooLarge) return { modern: false, response: requestBodyTooLargeResponse() };
  const version = readBodyProtocolVersion(body.value);
  if (version === undefined) return { modern: false };
  if (version === MCP_PROTOCOL_VERSION) return { modern: true };

  return {
    modern: true,
    response: jsonRpcError(
      readJsonRpcRequestId(body.value),
      -32_022,
      "Unsupported protocol version",
      400,
      {
        requested: version,
        supported: [MCP_PROTOCOL_VERSION],
      },
    ),
  };
}

async function readRequestBody(
  request: Request,
): Promise<{ readonly tooLarge: boolean; readonly value?: unknown }> {
  const cloned = request.clone();
  if (cloned.body === null) return { tooLarge: false };

  const reader = cloned.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MCP_MAX_BODY_SIZE_BYTES) {
        void reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(chunk.value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { tooLarge: false };
  }
}

function requestBodyTooLargeResponse(): Response {
  return Response.json(
    { error: "Request body too large" },
    { status: 413, statusText: "Request Entity Too Large" },
  );
}

function readBodyProtocolVersion(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const params = Reflect.get(body, "params");
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const meta = Reflect.get(params, "_meta");
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const version = Reflect.get(meta, "io.modelcontextprotocol/protocolVersion");
  return typeof version === "string" ? version : undefined;
}

function readJsonRpcRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const id = Reflect.get(body, "id");
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function readJsonRpcRequestMethod(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const method = Reflect.get(body, "method");
  return typeof method === "string" ? method : undefined;
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status: number,
  data?: Readonly<Record<string, unknown>>,
): Response {
  const error: {
    readonly code: number;
    readonly message: string;
    data?: Readonly<Record<string, unknown>>;
  } = { code, message };
  if (data !== undefined) error.data = data;
  return Response.json(
    {
      error,
      id,
      jsonrpc: "2.0",
    },
    { status },
  );
}

async function callTool(
  tool: McpServerTool,
  input: unknown,
  signal: AbortSignal,
  auth: SessionAuthContext | null,
): Promise<McpCallToolResult> {
  try {
    return await tool.call(input, { auth, signal });
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Tool call failed.");
  }
}

function toolError(message: string): McpCallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
