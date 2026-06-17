/**
 * Shared identity for eve integrations. This package is the single source of
 * truth for *which* integrations exist (channels and connections) and how a
 * connection is wired (transport + model-facing description).
 *
 * Surface-specific concerns live with their consumer, keyed by {@link
 * IntegrationEntry.slug}: the scaffolder (eve) overlays the
 * Connect auth spec it emits, and the docs gallery overlays presentation
 * (logo, keywords, auth modes, hand-authored markdown). Neither re-declares the
 * identity below.
 *
 * Everything lives in this one module on purpose. The catalog is consumed
 * directly from source by both NodeNext tooling (`tsgo` in eve,
 * which requires explicit `.js` import extensions) and Turbopack (the docs app,
 * which cannot resolve `.js` specifiers back to `.ts`). A single file with no
 * relative imports is the only shape that satisfies both without per-consumer
 * resolver configuration.
 */

/** Surface an integration targets. Extend as new kinds are catalogued. */
export type IntegrationKind = "channel" | "connection";

/** Wire protocol a connection speaks at runtime. */
export type ConnectionProtocol = "mcp" | "openapi";

/** MCP transport: a single server URL, with optional static headers. */
export interface McpTransport {
  url: string;
  /** Static, non-secret headers sent on every request (literal values). */
  headers?: Record<string, string>;
}

/** OpenAPI transport: a spec document plus the API base URL. */
export interface OpenApiTransport {
  spec: string;
  baseUrl: string;
  /** Static, non-secret headers sent on every request (literal values). */
  headers?: Record<string, string>;
}

/** Transport + description identity for a connection; protocols are derived. */
export interface ConnectionIdentity {
  /** Model-facing description written into the generated definition. */
  description: string;
  mcp?: McpTransport;
  openapi?: OpenApiTransport;
}

/** Which eve surfaces an integration is available on today. */
export interface IntegrationSurfaces {
  /** The eve CLI can scaffold this integration without further work. */
  scaffoldable: boolean;
  /** Listed in the docs integrations gallery. */
  gallery: boolean;
}

/** Canonical identity for one integration, shared across every surface. */
export interface IntegrationEntry {
  /** Filename + lookup key + runtime name (e.g. `linear`). Derived once. */
  slug: string;
  /** Human label (e.g. `Linear`). */
  name: string;
  kind: IntegrationKind;
  /** One-line summary; reused by docs gallery cards and CLI hints. */
  tagline: string;
  surfaces: IntegrationSurfaces;
  /** Present only for `kind: "connection"`. */
  connection?: ConnectionIdentity;
}

/** Protocols a connection speaks, derived from its declared transports. */
export function connectionProtocols(connection: ConnectionIdentity): ConnectionProtocol[] {
  return [
    connection.mcp ? ("mcp" as const) : null,
    connection.openapi ? ("openapi" as const) : null,
  ].filter((protocol): protocol is ConnectionProtocol => protocol !== null);
}

/**
 * The canonical set of eve integrations. Order is display order. Each entry
 * carries only shared identity; the scaffolder and docs overlay their own
 * surface-specific data keyed by {@link IntegrationEntry.slug}.
 *
 * `surfaces.scaffoldable` reflects what the CLI can scaffold today: Slack and
 * eve Web Chat for channels, and every curated connection. The remaining
 * channels are runtime modules that are still configured by hand, so they
 * appear in the gallery but not the CLI picker.
 */
export const INTEGRATIONS: readonly IntegrationEntry[] = [
  {
    slug: "slack",
    name: "Slack",
    kind: "channel",
    tagline: "Mention your agent in channels and DMs, with Connect-managed auth.",
    surfaces: { scaffoldable: true, gallery: true },
  },
  {
    slug: "discord",
    name: "Discord",
    kind: "channel",
    tagline: "Run your agent as a Discord bot across servers and threads.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "teams",
    name: "Microsoft Teams",
    kind: "channel",
    tagline: "Bring your agent into Teams chats and channels.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "telegram",
    name: "Telegram",
    kind: "channel",
    tagline: "Connect your agent to a Telegram bot for 1:1 and group chats.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "twilio",
    name: "Twilio",
    kind: "channel",
    tagline: "Reach users over SMS and WhatsApp through Twilio.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "github",
    name: "GitHub",
    kind: "channel",
    tagline: "Drive your agent from issues, pull requests, and comments.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "linear-agent",
    name: "Linear Agent",
    kind: "channel",
    tagline: "Delegate Linear issues and comments to your agent through Linear's Agent Sessions.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "eve",
    name: "eve Web Chat",
    kind: "channel",
    tagline: "Embed a first-party web chat UI backed by your agent.",
    surfaces: { scaffoldable: true, gallery: true },
  },
  {
    slug: "linear",
    name: "Linear",
    kind: "connection",
    tagline: "Issues, projects, cycles, and comments via Linear's MCP server.",
    surfaces: { scaffoldable: true, gallery: true },
    connection: {
      description: "Linear workspace: issues, projects, cycles, and comments.",
      mcp: { url: "https://mcp.linear.app/sse" },
    },
  },
  {
    slug: "notion",
    name: "Notion",
    kind: "connection",
    tagline: "Search and edit Notion pages and databases over MCP or OpenAPI.",
    surfaces: { scaffoldable: true, gallery: true },
    connection: {
      description: "Notion workspace: search and edit pages and databases.",
      mcp: { url: "https://mcp.notion.com/mcp" },
      openapi: {
        spec: "https://developers.notion.com/openapi.json",
        baseUrl: "https://api.notion.com",
        headers: { "Notion-Version": "2022-06-28" },
      },
    },
  },
  {
    slug: "datadog",
    name: "Datadog",
    kind: "connection",
    tagline: "Query metrics, monitors, and logs through Datadog's MCP server.",
    surfaces: { scaffoldable: true, gallery: true },
    connection: {
      description: "Datadog: query metrics, monitors, logs, and incidents.",
      mcp: { url: "https://mcp.datadoghq.com/api/mcp" },
    },
  },
  {
    slug: "honeycomb",
    name: "Honeycomb",
    kind: "connection",
    tagline: "Explore traces and run queries through Honeycomb's MCP server.",
    surfaces: { scaffoldable: true, gallery: true },
    connection: {
      description: "Honeycomb: explore traces, run queries, and inspect datasets.",
      mcp: { url: "https://mcp.honeycomb.io/mcp" },
    },
  },
];

const BY_SLUG = new Map(INTEGRATIONS.map((entry) => [entry.slug, entry]));

/** Returns the catalog entry for a slug, or `undefined` when not catalogued. */
export function getIntegrationEntry(slug: string): IntegrationEntry | undefined {
  return BY_SLUG.get(slug);
}

/** All entries of a kind, in catalog order. */
export function integrationsByKind(kind: IntegrationKind): IntegrationEntry[] {
  return INTEGRATIONS.filter((entry) => entry.kind === kind);
}

/** All connection entries, in catalog order. */
export function connectionEntries(): IntegrationEntry[] {
  return integrationsByKind("connection");
}

/** All channel entries, in catalog order. */
export function channelEntries(): IntegrationEntry[] {
  return integrationsByKind("channel");
}
