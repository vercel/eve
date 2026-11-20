import {
  type ConnectionIdentity,
  type ConnectionProtocol,
  connectionEntries,
  connectionProtocols,
} from "#compiled/@eve/catalog/index.js";

export type { ConnectionProtocol };

export const SUPPORTED_PROTOCOLS: readonly ConnectionProtocol[] = ["mcp"];

export interface EnvHeader {
  header: string;
  envVar: string;
}

export type ConnectionAuthSpec =
  | { kind: "connect"; connector: string; service?: string }
  | { kind: "bearer-env"; envVar: string }
  | { kind: "header"; headers: readonly EnvHeader[] }
  | { kind: "none" };

export interface McpEndpoint {
  url: string;
}

export interface OpenApiEndpoint {
  spec: string;
  baseUrl?: string;
}

export interface ConnectionCatalogEntry {
  slug: string;
  label: string;
  hint?: string;
  protocols: readonly ConnectionProtocol[];
  description: string;
  mcp?: McpEndpoint;
  openapi?: OpenApiEndpoint;
  auth: ConnectionAuthSpec;
}

export interface CustomConnectionInput {
  slug: string;
  description: string;
  protocols: readonly ConnectionProtocol[];
  mcp?: McpEndpoint;
  openapi?: OpenApiEndpoint;
  auth?: ConnectionAuthSpec;
}

export const CUSTOM_CONNECTION_SLUG = "custom";

const CONNECTION_AUTH: Readonly<Record<string, ConnectionAuthSpec>> = {
  "browser-use": {
    kind: "header",
    headers: [{ header: "x-browser-use-api-key", envVar: "BROWSER_USE_API_KEY" }],
  },
  linear: { kind: "connect", connector: "linear", service: "mcp.linear.app" },
  notion: { kind: "connect", connector: "notion", service: "mcp.notion.com" },
  datadog: { kind: "connect", connector: "datadog", service: "mcp.datadoghq.com" },
  honeycomb: { kind: "connect", connector: "honeycomb", service: "mcp.honeycomb.io" },
};

function buildCatalogEntry(
  slug: string,
  label: string,
  identity: ConnectionIdentity,
): ConnectionCatalogEntry {
  const auth = CONNECTION_AUTH[slug];
  if (auth === undefined) {
    throw new Error(`Connection "${slug}" is in the catalog but has no scaffolder auth overlay.`);
  }
  const entry: ConnectionCatalogEntry = {
    slug,
    label,
    protocols: connectionProtocols(identity),
    description: identity.description,
    auth,
  };
  if (identity.mcp) entry.mcp = { url: identity.mcp.url };
  if (identity.openapi)
    entry.openapi = { spec: identity.openapi.spec, baseUrl: identity.openapi.baseUrl };
  return entry;
}

export const CONNECTION_CATALOG: readonly ConnectionCatalogEntry[] = connectionEntries()
  .filter((entry) => entry.surfaces.scaffoldable)
  .map((entry) => {
    if (entry.connection === undefined) {
      throw new Error(`Catalog connection "${entry.slug}" is missing its connection identity.`);
    }
    return buildCatalogEntry(entry.slug, entry.name, entry.connection);
  });

const CATALOG_BY_SLUG = new Map(CONNECTION_CATALOG.map((entry) => [entry.slug, entry]));

export function getCatalogEntry(slug: string): ConnectionCatalogEntry | undefined {
  return CATALOG_BY_SLUG.get(slug);
}

export function catalogSlugs(): string[] {
  return CONNECTION_CATALOG.map((entry) => entry.slug);
}

export function effectiveProtocols(
  declared: readonly ConnectionProtocol[] | undefined,
): ConnectionProtocol[] {
  const declaredSet =
    declared === undefined || declared.length === 0 ? SUPPORTED_PROTOCOLS : declared;
  return SUPPORTED_PROTOCOLS.filter((protocol) => declaredSet.includes(protocol));
}

const CONNECTION_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidConnectionSlug(slug: string): boolean {
  return CONNECTION_SLUG_PATTERN.test(slug);
}

export function endpointForProtocol(
  entry: Pick<ConnectionCatalogEntry, "mcp" | "openapi">,
  protocol: ConnectionProtocol,
): McpEndpoint | OpenApiEndpoint | null {
  if (protocol === "mcp") return entry.mcp ?? null;
  return entry.openapi ?? null;
}
