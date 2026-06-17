/**
 * Build-time catalog of known eve connections. Each entry drives both the
 * `eve connections add` picker and the per-entry scaffold template.
 *
 * Connection *identity* (slug, label, transport, description) is owned by
 * `@vercel/eve-catalog`, the cross-surface source of truth shared with the
 * docs gallery. This module overlays the scaffolder-only concern — the Connect
 * auth spec to emit — and shapes the result into {@link ConnectionCatalogEntry}.
 *
 * Phase 1 ships MCP-only scaffolding plus a "custom" escape hatch. OpenAPI
 * entries can be scaffolded later by widening {@link SUPPORTED_PROTOCOLS}, with
 * no command-surface change.
 */

import {
  type ConnectionIdentity,
  type ConnectionProtocol,
  connectionEntries,
  connectionProtocols,
} from "@vercel/eve-catalog";

/** Wire protocol a connection speaks at runtime. */
export type { ConnectionProtocol };

/** Protocols the scaffolder can currently emit. */
export const SUPPORTED_PROTOCOLS: readonly ConnectionProtocol[] = ["mcp"];

/** Maps an outgoing request header to the environment variable that supplies it. */
export interface EnvHeader {
  /** Header sent to the connection endpoint (e.g. `DD-API-KEY`). */
  header: string;
  /** Environment variable that holds the value (e.g. `DD_API_KEY`). */
  envVar: string;
}

/** How a scaffolded connection authenticates to its endpoint. */
export type ConnectionAuthSpec =
  /**
   * Vercel Connect-managed OAuth via `connect(<connector>)`.
   *
   * `connector` is the value written into the generated `connect("…")` call.
   * It starts as a placeholder and is rewritten to the real connector UID once
   * the connector is provisioned (see {@link service}). `service` is the
   * managed-connector identifier passed to `vercel connect create <service>`
   * (e.g. the MCP host `mcp.linear.app`); when omitted, the connector must be
   * created out of band and its UID set by hand.
   */
  | { kind: "connect"; connector: string; service?: string }
  /** Static bearer token read from a single environment variable. */
  | { kind: "bearer-env"; envVar: string }
  /** Static credentials passed as one or more request headers. */
  | { kind: "header"; headers: readonly EnvHeader[] }
  /** No auth (public or locally-trusted endpoints). */
  | { kind: "none" };

/** Per-protocol endpoint configuration. */
export interface McpEndpoint {
  url: string;
}

export interface OpenApiEndpoint {
  spec: string;
  baseUrl?: string;
}

/** A known connection the picker can scaffold without further input. */
export interface ConnectionCatalogEntry {
  /** File name + runtime connection name (e.g. `linear`). */
  slug: string;
  /** Human label shown in the picker (e.g. `Linear`). */
  label: string;
  /** Short qualifier shown next to the label (e.g. `OAuth via Connect`). */
  hint?: string;
  /** Protocols this service supports. */
  protocols: readonly ConnectionProtocol[];
  /** Description written into the generated definition. */
  description: string;
  /** MCP endpoint, present iff `"mcp"` is in {@link protocols}. */
  mcp?: McpEndpoint;
  /** OpenAPI endpoint, present iff `"openapi"` is in {@link protocols}. */
  openapi?: OpenApiEndpoint;
  /** Authentication strategy emitted into the template. */
  auth: ConnectionAuthSpec;
}

/** Free-form connection supplied through the custom picker option. */
export interface CustomConnectionInput {
  slug: string;
  description: string;
  protocols: readonly ConnectionProtocol[];
  mcp?: McpEndpoint;
  openapi?: OpenApiEndpoint;
  auth?: ConnectionAuthSpec;
}

/** Sentinel picker value for the "Custom connection" option. */
export const CUSTOM_CONNECTION_SLUG = "custom";

/**
 * Scaffolder-only auth overlay, keyed by catalog slug. Identity comes from
 * `@vercel/eve-catalog`; this map says how each curated connection authenticates
 * when the scaffolder emits its template. Every connection in the catalog must
 * have an entry here — {@link buildCatalogEntry} throws otherwise.
 */
const CONNECTION_AUTH: Readonly<Record<string, ConnectionAuthSpec>> = {
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

export const CONNECTION_CATALOG: readonly ConnectionCatalogEntry[] = connectionEntries().map(
  (entry) => {
    if (entry.connection === undefined) {
      throw new Error(`Catalog connection "${entry.slug}" is missing its connection identity.`);
    }
    return buildCatalogEntry(entry.slug, entry.name, entry.connection);
  },
);

const CATALOG_BY_SLUG = new Map(CONNECTION_CATALOG.map((entry) => [entry.slug, entry]));

/** Returns the catalog entry for a slug, or `undefined` when not curated. */
export function getCatalogEntry(slug: string): ConnectionCatalogEntry | undefined {
  return CATALOG_BY_SLUG.get(slug);
}

/** All curated connection slugs, in catalog order. */
export function catalogSlugs(): string[] {
  return CONNECTION_CATALOG.map((entry) => entry.slug);
}

/**
 * Effective protocols for an entry: the intersection of what the scaffolder
 * supports and what the entry declares. Custom inputs use the full supported
 * set when they declare no protocols.
 */
export function effectiveProtocols(
  declared: readonly ConnectionProtocol[] | undefined,
): ConnectionProtocol[] {
  const declaredSet =
    declared === undefined || declared.length === 0 ? SUPPORTED_PROTOCOLS : declared;
  return SUPPORTED_PROTOCOLS.filter((protocol) => declaredSet.includes(protocol));
}

/**
 * Connection filename charset. Must mirror the framework's discovery grammar
 * (`CONNECTION_SLUG_PATTERN` in `eve/src/discover/grammar.ts`): a lowercase
 * letter followed by lowercase letters, digits, and dashes, up to 64
 * characters. Underscores and leading digits are rejected so the scaffolder
 * never writes a connection file that `eve build` would later refuse to
 * discover.
 */
const CONNECTION_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** True when a slug is a valid filesystem-derived connection name. */
export function isValidConnectionSlug(slug: string): boolean {
  return CONNECTION_SLUG_PATTERN.test(slug);
}

/**
 * The `vercel connect create <service>` identifier for a Connect-backed
 * connection: the explicit `auth.service` when set, otherwise the host of the
 * MCP endpoint (e.g. `mcp.linear.app`). Returns `undefined` when neither is
 * available, in which case the connector must be provisioned out of band.
 */
export function connectorServiceForEntry(
  entry: Pick<ConnectionCatalogEntry, "mcp" | "auth">,
): string | undefined {
  if (entry.auth.kind !== "connect") return undefined;
  if (entry.auth.service) return entry.auth.service;
  return mcpServiceHost(entry.mcp?.url);
}

/** Extracts the bare host from an MCP URL, or `undefined` when unparseable. */
export function mcpServiceHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Returns the endpoint block required for a protocol, or `null` when missing. */
export function endpointForProtocol(
  entry: Pick<ConnectionCatalogEntry, "mcp" | "openapi">,
  protocol: ConnectionProtocol,
): McpEndpoint | OpenApiEndpoint | null {
  if (protocol === "mcp") return entry.mcp ?? null;
  return entry.openapi ?? null;
}
