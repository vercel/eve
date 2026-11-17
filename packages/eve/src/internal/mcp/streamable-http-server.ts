import { context as otelContext } from "#compiled/@opentelemetry/api/index.js";
import {
  createMcpHandler,
  McpServer,
  type CacheHint,
  type McpJsonObject,
  type McpServerOptions,
  type McpToolAnnotations,
  type StandardSchemaIssue,
  type StandardSchemaWithJSON,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { withMcpRequestTraceContext } from "#internal/mcp/request-trace-context.js";

const log = createLogger("mcp.server");

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_REQUEST_BODY_MAX_BYTES = 1024 * 1024;

export const MCP_LIST_CACHE_HINT = {
  cacheScope: "private",
  ttlMs: 5 * 60 * 1000,
} as const satisfies CacheHint;

const CACHE_HINTED_METHODS = [
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "server/discover",
  "tools/list",
] as const;

interface McpToolDefinition<TInputSchema extends StandardSchemaWithJSON = StandardSchemaWithJSON> {
  readonly name: string;
  readonly description?: string;
  readonly annotations?: McpToolAnnotations;
  readonly inputSchema: TInputSchema;
  readonly outputSchema?: StandardSchemaWithJSON;
}

export interface McpCallToolResult<TStructured = Readonly<Record<string, unknown>>> {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: TStructured | McpToolOperationErrorEnvelope;
}

export interface McpToolOperationErrorEnvelope {
  readonly error: McpToolOperationErrorData;
}

export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly name: string; readonly uri: string };

type McpToolOperationErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "denied"
  | "approval_required"
  | "authorization_required"
  | "internal";

interface McpToolOperationErrorData {
  readonly code: McpToolOperationErrorCode;
  readonly errorId?: string;
  readonly message: string;
  readonly retryable: boolean;
}

export class McpToolOperationError extends Error {
  readonly code: McpToolOperationErrorCode;

  constructor(code: McpToolOperationErrorCode, message: string) {
    super(message);
    this.name = "McpToolOperationError";
    this.code = code;
  }
}

const RETRYABLE_CODES: ReadonlySet<McpToolOperationErrorCode> = new Set(["conflict"]);

export interface McpToolCallContext {
  readonly auth: SessionAuthContext | null;
  readonly clientCapabilities: unknown;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
  readonly signal: AbortSignal;
}

export interface McpServerTool {
  readonly name: string;
  register(server: McpServer, auth: SessionAuthContext | null): void;
}

export interface McpServerFeature {
  readonly capabilities: McpJsonObject;
  register(server: McpServer): void;
}

type InferSchemaOutput<TSchema> =
  TSchema extends StandardSchemaWithJSON<unknown, infer TOutput> ? TOutput : never;

export function defineMcpTool<
  const TInputSchema extends StandardSchemaWithJSON<unknown, unknown>,
  TStructured = Readonly<Record<string, unknown>>,
>(input: {
  readonly definition: McpToolDefinition<TInputSchema>;
  call(
    value: InferSchemaOutput<TInputSchema>,
    context: McpToolCallContext,
  ): Promise<McpCallToolResult<TStructured>>;
}): McpServerTool {
  return {
    name: input.definition.name,
    register(server, auth) {
      server.registerTool(
        input.definition.name,
        {
          ...(input.definition.annotations === undefined
            ? {}
            : { annotations: input.definition.annotations }),
          ...(input.definition.description === undefined
            ? {}
            : { description: input.definition.description }),
          inputSchema: advertiseOnly(input.definition.inputSchema),
          ...(input.definition.outputSchema === undefined
            ? {}
            : { outputSchema: input.definition.outputSchema }),
        },
        async (value, context) => {
          const checked = await input.definition.inputSchema["~standard"].validate(value);
          if (checked.issues !== undefined) {
            return toolError({
              code: "invalid_input",
              message: `Invalid arguments for tool ${input.definition.name}: ${checked.issues.map(formatIssue).join(", ")}`,
              retryable: false,
            });
          }
          return await callTool(input.call, checked.value as InferSchemaOutput<TInputSchema>, {
            auth,
            clientCapabilities: declaredClientCapabilities(context.mcpReq.envelope),
            meta: context.mcpReq._meta,
            signal: context.mcpReq.signal,
          });
        },
      );
    },
  };
}

function advertiseOnly(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema["~standard"];
  return {
    "~standard": {
      jsonSchema: standard.jsonSchema,
      validate: (value) => ({ value }),
      vendor: standard.vendor,
      version: standard.version,
    },
  };
}

function formatIssue(issue: StandardSchemaIssue): string {
  if (issue.path === undefined || issue.path.length === 0) return issue.message;
  const path = issue.path
    .map((segment) => String(typeof segment === "object" ? segment.key : segment))
    .join(".");
  return `${path}: ${issue.message}`;
}

interface McpStreamableHttpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
  readonly tools?: readonly McpServerTool[];
  readonly features?: readonly McpServerFeature[];
  authenticate(request: Request): Promise<SessionAuthContext | null | Response>;
}

export function createMcpStreamableHttpServer(
  options: McpStreamableHttpServerOptions,
): (request: Request) => Promise<Response> {
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  if (tools.size !== (options.tools?.length ?? 0)) {
    throw new Error("MCP tool names must be unique.");
  }

  return async (request) => {
    const auth = await options.authenticate(request);
    if (auth instanceof Response) return auth;

    const handler = createMcpHandler(() => createServer(options, tools, auth), {
      legacy: "stateless",
    });
    if (request.method.toUpperCase() !== "POST") return await handler.fetch(request);

    const inspected = await inspectRequestBody(request);
    if (inspected.tooLarge) return requestBodyTooLargeResponse();
    if (inspected.invalidJson) return invalidJsonResponse();
    const parsedBody = inspected.value;
    if (parsedBody === undefined) return await handler.fetch(request);

    const preflightFailure = await preflightModernRequest(request, parsedBody);
    if (preflightFailure !== undefined) return preflightFailure;

    return await otelContext.with(
      withMcpRequestTraceContext(otelContext.active(), parsedBody),
      () => handler.fetch(request, { parsedBody }),
    );
  };
}

async function preflightModernRequest(
  request: Request,
  parsedBody: unknown,
): Promise<Response | undefined> {
  if (request.headers.has("mcp-protocol-version")) return undefined;
  if (!claimsCurrentProtocolVersion(parsedBody)) return undefined;

  const earlierFailure = await probeEarlierValidationFailure(request, parsedBody);
  return earlierFailure ?? headerMismatchResponse(parsedBody);
}

async function inspectRequestBody(request: Request): Promise<{
  readonly invalidJson?: boolean;
  readonly tooLarge: boolean;
  readonly value?: unknown;
}> {
  const body = request.body;
  if (body === null) return { tooLarge: false };

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MCP_REQUEST_BODY_MAX_BYTES) {
    await body.cancel().catch(() => {});
    return { tooLarge: true };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MCP_REQUEST_BODY_MAX_BYTES) {
        await reader.cancel();
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
    return { invalidJson: true, tooLarge: false };
  }
}

function invalidJsonResponse(): Response {
  return Response.json(
    {
      error: { code: -32_700, message: "Parse error" },
      id: null,
      jsonrpc: "2.0",
    },
    { status: 400 },
  );
}

function requestBodyTooLargeResponse(): Response {
  return Response.json(
    {
      error: { code: -32_000, message: "Request body too large" },
      id: null,
      jsonrpc: "2.0",
    },
    { status: 413, statusText: "Request Entity Too Large" },
  );
}

function claimsCurrentProtocolVersion(body: unknown): boolean {
  return (
    isPlainRecord(body) &&
    isPlainRecord(body.params) &&
    isPlainRecord(body.params._meta) &&
    body.params._meta["io.modelcontextprotocol/protocolVersion"] === MCP_PROTOCOL_VERSION
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function probeEarlierValidationFailure(
  request: Request,
  parsedBody: unknown,
): Promise<Response | undefined> {
  const headers = new Headers(request.headers);
  headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  const probeRequest = new Request(request.url, {
    body: JSON.stringify(parsedBody),
    headers,
    method: request.method,
  });
  const probe = createMcpHandler(() => new McpServer({ name: "eve-mcp-preflight", version: "0" }), {
    legacy: "reject",
  });
  try {
    const response = await probe.fetch(probeRequest, { parsedBody });
    if (response.status === 406 || response.status === 415) {
      return response;
    }
    if (response.status === 400) {
      const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { readonly error?: { readonly code?: unknown } } | undefined;
      if (
        body?.error?.code === -32_700 ||
        body?.error?.code === -32_600 ||
        body?.error?.code === -32_602 ||
        body?.error?.code === -32_022
      ) {
        return response;
      }
    }
    await response.body?.cancel();
    return undefined;
  } finally {
    await probe.close().catch(() => {});
  }
}

function headerMismatchResponse(body: unknown): Response {
  const mismatchBody =
    "the body carries a modern MCP envelope but the required MCP-Protocol-Version header is absent";
  return Response.json(
    {
      error: {
        code: -32_020,
        data: {
          mismatch: {
            body: mismatchBody,
            header: "(missing)",
          },
        },
        message: `Bad Request: the request headers and body disagree: ${mismatchBody}`,
      },
      id: readJsonRpcRequestId(body),
      jsonrpc: "2.0",
    },
    { status: 400 },
  );
}

function readJsonRpcRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const id = Reflect.get(body, "id");
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function createServer(
  options: Pick<
    McpStreamableHttpServerOptions,
    "features" | "instructions" | "name" | "tools" | "version"
  >,
  tools: ReadonlyMap<string, McpServerTool>,
  auth: SessionAuthContext | null,
): McpServer {
  const capabilities: Record<string, McpJsonObject> =
    options.tools === undefined ? {} : { tools: { listChanged: false } };
  for (const feature of options.features ?? []) {
    for (const [key, value] of Object.entries(feature.capabilities)) {
      capabilities[key] = { ...capabilities[key], ...(value as McpJsonObject) };
    }
  }
  const serverOptions: { -readonly [K in keyof McpServerOptions]: McpServerOptions[K] } = {
    cacheHints: Object.fromEntries(
      CACHE_HINTED_METHODS.map((method) => [method, MCP_LIST_CACHE_HINT]),
    ),
    capabilities,
  };
  if (options.instructions !== undefined) serverOptions.instructions = options.instructions;
  const server = new McpServer({ name: options.name, version: options.version }, serverOptions);

  for (const tool of tools.values()) tool.register(server, auth);
  for (const feature of options.features ?? []) feature.register(server);

  return server;
}

function declaredClientCapabilities(
  envelope: Readonly<Record<string, unknown>> | undefined,
): unknown {
  if (envelope?.["io.modelcontextprotocol/protocolVersion"] !== MCP_PROTOCOL_VERSION) {
    return undefined;
  }
  return envelope["io.modelcontextprotocol/clientCapabilities"];
}

async function callTool<TInput, TStructured>(
  call: (input: TInput, context: McpToolCallContext) => Promise<McpCallToolResult<TStructured>>,
  input: TInput,
  context: McpToolCallContext,
): Promise<McpCallToolResult<TStructured>> {
  try {
    return await call(input, context);
  } catch (error) {
    if (error instanceof McpToolOperationError) {
      return toolError({
        code: error.code,
        message: error.message,
        retryable: RETRYABLE_CODES.has(error.code),
      });
    }
    const errorId = logError(log, "MCP tool call failed", error);
    return toolError({
      code: "internal",
      errorId,
      message: "The server could not complete this tool call.",
      retryable: false,
    });
  }
}

function toolError<TStructured>(error: McpToolOperationErrorData): McpCallToolResult<TStructured> {
  const text =
    error.errorId === undefined ? error.message : `${error.message} (errorId: ${error.errorId})`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { error },
  };
}
