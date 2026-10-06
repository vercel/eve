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

export type McpJsonObject = Readonly<Record<string, unknown>>;

export interface McpRequestHandlerExtra {
  readonly mcpReq: {
    /** The 2026-07-28 per-request envelope (\`io.modelcontextprotocol/*\` keys). */
    readonly envelope?: McpJsonObject;
    /** Bare multi-round-trip responses keyed by the server's input request keys. */
    readonly inputResponses?: McpJsonObject;
    /** The value \`requestState.verify\` resolved with, or the raw string. */
    requestState<T = unknown>(): T | undefined;
    readonly signal: AbortSignal;
  };
}

export interface McpServerOptions {
  readonly capabilities?: McpJsonObject;
  readonly instructions?: string;
  readonly requestState?: {
    readonly verify?: (state: string, ctx: McpRequestHandlerExtra) => unknown;
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

export declare class Server {
  constructor(info: { readonly name: string; readonly version: string }, options?: {
    readonly capabilities?: Readonly<Record<string, unknown>>;
  });
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

export interface RequestStateCodec<T = unknown> {
  mint(payload: T): Promise<string>;
  verify(state: string, ctx: McpRequestHandlerExtra): Promise<T>;
}

export declare function createRequestStateCodec<T = unknown>(options: {
  readonly key: Uint8Array | string;
  readonly ttlSeconds?: number;
}): RequestStateCodec<T>;

export type InputResponseView =
  | { readonly kind: "missing" }
  | {
      readonly kind: "elicit";
      readonly action: "accept" | "cancel" | "decline";
      readonly content?: McpJsonObject;
    }
  | { readonly kind: "roots" }
  | { readonly kind: "sampling" };

export declare function inputResponse(
  responses: McpJsonObject | undefined,
  key: string,
): InputResponseView;

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
    readonly onerror?: (error: Error) => void;
    readonly responseMode?: "auto" | "json" | "stream";
  },
): McpHandler;
`,
    },
  ],
  platform: "neutral",
};
