/** Surface an integration targets. */
export type IntegrationKind = "channel" | "connection" | "extension" | "instrumentation";

/** Wire protocol a connection speaks at runtime. */
export type ConnectionProtocol = "mcp" | "openapi";

/** MCP transport: a single server URL, with optional static headers. */
export interface McpTransport {
  url: string;
  headers?: Record<string, string>;
}

/** OpenAPI transport: a spec document plus the API base URL. */
export interface OpenApiTransport {
  spec: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

/** Transport and description identity for a connection. */
export interface ConnectionIdentity {
  description: string;
  mcp?: McpTransport;
  openapi?: OpenApiTransport;
}

/** Which eve surfaces an integration is available on. */
export interface IntegrationSurfaces {
  scaffoldable: boolean;
  registry: boolean;
  gallery: boolean;
}

/** Canonical identity for one integration. */
export interface IntegrationEntry {
  slug: string;
  name: string;
  kind: IntegrationKind;
  tagline: string;
  surfaces: IntegrationSurfaces;
  connection?: ConnectionIdentity;
}

export declare function connectionProtocols(connection: ConnectionIdentity): ConnectionProtocol[];
export declare const INTEGRATIONS: readonly IntegrationEntry[];
export declare function getIntegrationEntry(slug: string): IntegrationEntry | undefined;
export declare function integrationsByKind(kind: IntegrationKind): IntegrationEntry[];
export declare function connectionEntries(): IntegrationEntry[];
export declare function channelEntries(): IntegrationEntry[];
export declare function extensionEntries(): IntegrationEntry[];
export declare function instrumentationEntries(): IntegrationEntry[];
