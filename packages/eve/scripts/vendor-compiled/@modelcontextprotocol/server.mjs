// Stop at the first failing array element before the SDK's errorsText joins
// every Ajv error. Keep its dialect selection and format validation unchanged.
// Fail the build on upstream drift rather than silently restoring allErrors.
function createFailFastValidationPlugin() {
  const source = `function createDefaultAjvInstance(engineClass) {
\tconst ajv = new engineClass({
\t\tstrict: false,
\t\tvalidateFormats: true,
\t\tvalidateSchema: false,
\t\tallErrors: true
\t});`;
  let patched = false;
  return {
    name: "eve-mcp-fail-fast-validation",
    buildStart() {
      patched = false;
    },
    transform(code, id) {
      if (
        !/\/@modelcontextprotocol\/server\/dist\/ajvProvider-[^/]+\.mjs$/.test(
          id.replaceAll("\\", "/"),
        )
      ) {
        return null;
      }
      if (code.split(source).length !== 2) {
        throw new Error("MCP SDK default Ajv configuration changed.");
      }
      patched = true;
      return {
        code: code.replace(source, source.replace("allErrors: true", "allErrors: false")),
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && !patched)
        throw new Error("MCP SDK fail-fast validation patch was not applied.");
    },
  };
}

export default {
  packageName: "@modelcontextprotocol/server",
  compiledPath: "@modelcontextprotocol/server",
  chunkGroup: "workflow",
  plugins: [createFailFastValidationPlugin()],
  entries: [
    {
      entry: "dist/index.mjs",
      outputPath: "index",
      declaration: `
export interface CallToolRequest {
  readonly params: {
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly name: string;
  };
}

export type McpJsonObject = Readonly<Record<string, unknown>>;

export interface McpRequestHandlerExtra {
  readonly mcpReq: {
    /** The request's \`_meta\`, without the reserved \`io.modelcontextprotocol/*\` keys. */
    readonly _meta?: Readonly<Record<string, unknown>>;
    /** The reserved \`io.modelcontextprotocol/*\` keys the request carried. */
    readonly envelope?: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
  };
}

export interface McpToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly readOnlyHint?: boolean;
}

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export type StandardSchemaResult<TOutput> =
  | { readonly value: TOutput; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaWithJSON<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
      readonly output: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export interface CacheHint {
  readonly cacheScope?: "private" | "public";
  readonly ttlMs?: number;
}

export type CacheableResultMethod =
  | "prompts/list"
  | "resources/list"
  | "resources/read"
  | "resources/templates/list"
  | "server/discover"
  | "tools/list";

export interface McpServerOptions {
  readonly cacheHints?: Partial<Record<CacheableResultMethod, CacheHint>>;
  readonly capabilities?: McpJsonObject;
  readonly instructions?: string;
  readonly maxToolInputElements?: number;
}

export declare class Server {
  constructor(info: { readonly name: string; readonly version: string }, options?: McpServerOptions);
  setRequestHandler<Result>(
    method: "tools/list",
    handler: (
      request: { readonly params: Readonly<Record<string, unknown>> },
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  setRequestHandler<Result>(
    method: "tools/call",
    handler: (
      request: CallToolRequest,
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  /** Spec methods validated by the SDK's own wire schemas. */
  setRequestHandler<Result>(
    method: "resources/list" | "resources/read" | "resources/templates/list",
    handler: (
      request: { readonly params?: McpJsonObject },
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  /** Custom (non-spec) methods: params are validated by the given schema. */
  setRequestHandler<TParams, Result>(
    method: string,
    schemas: { readonly params: StandardSchemaV1<unknown, TParams> },
    handler: (params: TParams, context: McpRequestHandlerExtra) => Result | Promise<Result>,
  ): void;
}

export declare class McpServer {
  readonly server: Server;
  constructor(info: { readonly name: string; readonly version: string }, options?: McpServerOptions);
  registerTool<TInput = unknown, TOutput = TInput>(
    name: string,
    config: {
      readonly annotations?: McpToolAnnotations;
      readonly description?: string;
      readonly inputSchema: StandardSchemaWithJSON<TInput, TOutput>;
      readonly outputSchema?: StandardSchemaWithJSON;
    },
    callback: (
      input: TOutput,
      context: McpRequestHandlerExtra,
    ) => unknown | Promise<unknown>,
  ): void;
}

export declare class ProtocolError extends Error {
  constructor(code: number, message: string, data?: unknown);
  readonly code: number;
  readonly data?: unknown;
}

export declare const ProtocolErrorCode: {
  readonly InternalError: -32603;
  readonly InvalidParams: -32602;
  readonly InvalidRequest: -32600;
  readonly MethodNotFound: -32601;
};

/** A resource miss, with data \`{ uri }\`. */
export declare class ResourceNotFoundError extends ProtocolError {
  constructor(uri: string, message?: string);
}

export interface McpRequestContext {
  readonly era: "legacy" | "modern";
  readonly requestInfo: Request;
}

export interface McpHandler {
  close(): Promise<void>;
  fetch(request: Request, options?: { readonly parsedBody?: unknown }): Promise<Response>;
}

export declare function fromJsonSchema<T = unknown>(
  schema: Readonly<Record<string, unknown>>,
): StandardSchemaWithJSON<T, T>;

export declare function hostHeaderValidationResponse(
  request: Request,
  allowedHostnames: readonly string[],
): Response | undefined;

export declare function originValidationResponse(
  request: Request,
  allowedOriginHostnames: readonly string[],
): Response | undefined;

export declare function createMcpHandler(
  factory: (context: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>,
  options?: {
    readonly legacy?: "reject" | "stateless";
    readonly maxRequestBodySize?: number;
    readonly onerror?: (error: Error) => void;
    readonly responseMode?: "auto" | "json" | "stream";
  },
): McpHandler;
`,
    },
  ],
  platform: "neutral",
};
