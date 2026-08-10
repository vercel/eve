export default {
  packageName: "h3-mcp",
  compiledPath: "h3-mcp",
  chunkGroup: "workflow",
  entries: [
    {
      entry: "dist/index.mjs",
      outputPath: "index",
      declaration: `
export interface McpToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly readOnlyHint?: boolean;
  readonly title?: string;
}

export interface StandardSchema {
  readonly "~standard": unknown;
}

export interface McpCallToolResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export interface McpToolDefinition {
  readonly annotations?: McpToolAnnotations;
  readonly description?: string;
  readonly handler: (
    input: unknown,
    event: { readonly req: Request },
  ) => McpCallToolResult | Promise<McpCallToolResult>;
  readonly inputSchema: StandardSchema;
  readonly name: string;
  readonly outputSchema?: StandardSchema;
}

export interface McpHandlerOptions {
  readonly era?: "dual" | "legacy" | "modern";
  readonly name: string;
  readonly origin?: false;
  readonly tools?: readonly McpToolDefinition[];
  readonly version: string;
}

export interface McpHandler {
  fetch(request: Request): Promise<Response>;
}

export declare function defineMcpHandler(options: McpHandlerOptions): McpHandler;
`,
    },
  ],
  platform: "neutral",
};
