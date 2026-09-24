export default {
  packageName: "@modelcontextprotocol/server",
  compiledPath: "@modelcontextprotocol/server",
  chunkGroup: "workflow",
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

export interface ReadResourceRequest {
  readonly params: {
    readonly uri: string;
  };
}

export interface McpRequestHandlerExtra {
  readonly mcpReq: {
    readonly signal: AbortSignal;
    /** MRTR input responses lifted from a retried request (untrusted). */
    readonly inputResponses?: Readonly<Record<string, unknown>>;
    /** MRTR request state echoed by the client (untrusted, unverified). */
    requestState<T = unknown>(): T | undefined;
  };
}

export interface McpToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly readOnlyHint?: boolean;
}

export interface StandardSchemaWithJSON<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export declare class Server {
  constructor(info: { readonly name: string; readonly version: string }, options?: {
    readonly capabilities?: Readonly<Record<string, unknown>>;
    readonly instructions?: string;
  });
  setRequestHandler<Result>(
    method: "resources/list" | "resources/templates/list",
    handler: (
      request: { readonly params?: Readonly<Record<string, unknown>> },
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  setRequestHandler<Result>(
    method: "resources/read",
    handler: (
      request: ReadResourceRequest,
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
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
}

export declare class McpServer {
  constructor(info: { readonly name: string; readonly version: string }, options?: {
    readonly capabilities?: Readonly<Record<string, unknown>>;
    readonly instructions?: string;
  });
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

export interface McpRequestContext {
  readonly era: "legacy" | "modern";
  readonly requestInfo: Request;
}

export interface McpHandler {
  close(): Promise<void>;
  fetch(request: Request, options?: { readonly parsedBody?: unknown }): Promise<Response>;
}

/** JSON-RPC invalid-params error carrying the unknown resource URI. */
export declare class ResourceNotFoundError extends Error {
  constructor(uri: string, message?: string);
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
    readonly onerror?: (error: Error) => void;
    readonly responseMode?: "auto" | "json" | "stream";
  },
): McpHandler;
`,
    },
  ],
  platform: "neutral",
};
