import type { ToolSet } from "ai";

export interface MCPListToolDefinition {
  annotations?: Record<string, unknown> | undefined;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  name: string;
  [key: string]: unknown;
}

export interface MCPListToolsResult {
  tools: MCPListToolDefinition[];
  [key: string]: unknown;
}

export interface MCPClient {
  listTools(options?: unknown): Promise<MCPListToolsResult>;
  toolsFromDefinitions(definitions: MCPListToolsResult, options?: unknown): ToolSet;
  close(): Promise<void>;
}

export interface MCPClientConfig {
  transport:
    | {
        type: "http" | "sse";
        url: string;
        headers?: Record<string, string> | undefined;
      }
    | unknown;
  onUncaughtError?: ((error: unknown) => void) | undefined;
  clientName?: string | undefined;
  name?: string | undefined;
  version?: string | undefined;
  capabilities?: unknown;
}

export declare function createMCPClient(config: MCPClientConfig): Promise<MCPClient>;
