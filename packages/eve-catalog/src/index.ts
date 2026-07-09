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
 * directly from source by both NodeNext tooling (`tsc` in eve,
 * which requires explicit `.js` import extensions) and Turbopack (the docs app,
 * which cannot resolve `.js` specifiers back to `.ts`). A single file with no
 * relative imports is the only shape that satisfies both without per-consumer
 * resolver configuration.
 */

/** Surface an integration targets. Extend as new kinds are catalogued. */
export type IntegrationKind = "channel" | "connection";

/** Wire protocol a connection speaks at runtime. */
export type ConnectionProtocol = "mcp" | "openapi";

/** Provenance for catalog data shown on dynamic connection surfaces. */
export type CatalogBasis =
  | { via: "curated"; source: "eve-catalog" }
  | { via: "declared"; source: string }
  | { via: "detected"; signal: string; verifiedAt?: string }
  | { via: "generated"; source: string; reviewed?: boolean };

/** Vercel Connect token subject or static credential shape for a surface. */
export type ConnectionCredentialType =
  | "connect_user"
  | "connect_app"
  | "connect_jwt_bearer"
  | "api_key"
  | "bearer"
  | "basic"
  | "oauth2"
  | "custom";

/** Credential declared once per integration and referenced by surfaces. */
export interface ConnectionCredential {
  type: ConnectionCredentialType;
  label: string;
  description?: string;
  connector?: string;
  /** Service or exact URL passed to `vercel connect create` when provisionable. */
  service?: string;
  fields?: Record<string, { secret?: boolean; description?: string }>;
}

/** How a surface applies one credential. */
export type ConnectionCredentialMechanics =
  | {
      source: "connect";
      connector: string;
      principalType?: "user" | "app" | "jwt-bearer";
      tokenParams?: Record<string, unknown>;
    }
  | {
      source: "http";
      in: "header" | "query";
      headerName?: string;
      scheme?: string;
      paramName?: string;
    }
  | { source: "env"; envVars: string[] }
  | { source: "spec"; scheme: string }
  | { source: "unknown" };

/** One credential reference inside a surface auth option. */
export interface ConnectionCredentialUse {
  id: string;
  mechanics: ConnectionCredentialMechanics;
}

/** Auth choices exposed by a surface. */
export type ConnectionSurfaceAuth =
  | { status: "none"; basis: CatalogBasis }
  | {
      status: "required";
      entries: Array<{
        id: string;
        label: string;
        use: ConnectionCredentialUse[];
        basis: CatalogBasis;
      }>;
    }
  | { status: "unknown"; basis?: CatalogBasis };

interface ConnectionSurfaceBase {
  slug: ConnectionProtocol;
  type: ConnectionProtocol;
  name: string;
  description?: string;
  docsHref?: string;
  basis: CatalogBasis;
  auth: ConnectionSurfaceAuth;
  scaffoldable?: boolean;
}

export interface McpConnectionSurface extends ConnectionSurfaceBase {
  slug: "mcp";
  type: "mcp";
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
}

export interface OpenApiConnectionSurface extends ConnectionSurfaceBase {
  slug: "openapi";
  type: "openapi";
  spec: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export type ConnectionSurfaceRecord = McpConnectionSurface | OpenApiConnectionSurface;

/** Rich connection-only catalog record consumed by the dynamic integrations page. */
export interface ConnectionIntegrationRecord {
  slug: string;
  name: string;
  tagline: string;
  categories?: string[];
  keywords?: string[];
  basis: CatalogBasis;
  credentials?: Record<string, ConnectionCredential>;
  surfaces: ConnectionSurfaceRecord[];
  availability: {
    gallery: boolean;
    docs: boolean;
    cli: boolean;
    json?: boolean;
  };
}

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
      mcp: { url: "https://mcp.linear.app/mcp" },
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
  {
    slug: "stripe",
    name: "Stripe",
    kind: "connection",
    tagline: "Customers, payments, billing, and Stripe docs over MCP or OpenAPI.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Stripe: customers, payments, billing, invoices, and subscriptions.",
      mcp: { url: "https://mcp.stripe.com" },
      openapi: {
        spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
        baseUrl: "https://api.stripe.com",
      },
    },
  },
  {
    slug: "sentry",
    name: "Sentry",
    kind: "connection",
    tagline: "Investigate issues, projects, releases, and events over MCP or OpenAPI.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Sentry: issues, events, projects, releases, organizations, and teams.",
      mcp: { url: "https://mcp.sentry.dev/mcp" },
      openapi: {
        spec: "https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi-derefed.json",
        baseUrl: "https://sentry.io/api/0",
      },
    },
  },
  {
    slug: "github-rest",
    name: "GitHub REST",
    kind: "connection",
    tagline: "Repositories, issues, pull requests, and workflows through GitHub's OpenAPI spec.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "GitHub REST API: repositories, issues, pull requests, workflows, and teams.",
      openapi: {
        spec: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml",
        baseUrl: "https://api.github.com",
        headers: { "X-GitHub-Api-Version": "2022-11-28" },
      },
    },
  },
  {
    slug: "asana",
    name: "Asana",
    kind: "connection",
    tagline: "Tasks, projects, portfolios, and workspaces through Asana's OpenAPI spec.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Asana: tasks, projects, portfolios, workspaces, and comments.",
      openapi: {
        spec: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml",
        baseUrl: "https://app.asana.com/api/1.0",
      },
    },
  },
  {
    slug: "jira",
    name: "Jira",
    kind: "connection",
    tagline: "Issues, projects, fields, and users through Jira Cloud's OpenAPI spec.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Jira Cloud: issues, projects, fields, users, and workflows.",
      openapi: {
        spec: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
        baseUrl: "https://your-domain.atlassian.net",
      },
    },
  },
  {
    slug: "slack-web-api",
    name: "Slack Web API",
    kind: "connection",
    tagline: "Channels, messages, users, and files through Slack's Web API OpenAPI spec.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Slack Web API: channels, messages, users, files, and workspace metadata.",
      openapi: {
        spec: "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2_without_examples.json",
        baseUrl: "https://slack.com/api",
      },
    },
  },
  {
    slug: "twilio-api",
    name: "Twilio API",
    kind: "connection",
    tagline: "Messages, calls, phone numbers, and accounts through Twilio's OpenAPI spec.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Twilio API: messages, calls, phone numbers, accounts, and usage records.",
      openapi: {
        spec: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/yaml/twilio_api_v2010.yaml",
        baseUrl: "https://api.twilio.com",
      },
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

const CURATED_BASIS = { via: "curated", source: "eve-catalog" } as const satisfies CatalogBasis;

const bearerCredential = (
  label: string,
  envVar: string,
  description: string,
): ConnectionCredential => ({
  type: "bearer",
  label,
  fields: {
    [envVar]: { secret: true, description },
  },
});

const basicCredential = (
  label: string,
  fields: Record<string, { secret?: boolean; description: string }>,
): ConnectionCredential => ({
  type: "basic",
  label,
  fields,
});

const httpHeaderAuth = (
  id: "apiKey" | "basic",
  label: string,
  credentialId: string,
  scheme: string,
): ConnectionSurfaceAuth => ({
  status: "required",
  entries: [
    {
      id,
      label,
      use: [
        {
          id: credentialId,
          mechanics: {
            source: "http",
            in: "header",
            headerName: "Authorization",
            scheme,
          },
        },
      ],
      basis: CURATED_BASIS,
    },
  ],
});

const CONNECTION_METADATA: Readonly<
  Record<
    string,
    {
      categories?: string[];
      keywords?: string[];
      credentials: Record<string, ConnectionCredential>;
      authByProtocol: Partial<Record<ConnectionProtocol, ConnectionSurfaceAuth>>;
      mcpTransport?: McpConnectionSurface["transport"];
    }
  >
> = {
  linear: {
    categories: ["project management", "engineering"],
    keywords: ["issues", "projects", "cycles", "comments", "oauth", "connect"],
    credentials: {
      connect_user: {
        type: "connect_user",
        label: "Linear user OAuth",
        connector: "mcp.linear.app/my-agent",
        service: "https://mcp.linear.app/sse",
      },
      connect_app: {
        type: "connect_app",
        label: "Linear app connection",
        connector: "mcp.linear.app/my-agent",
        service: "https://mcp.linear.app/sse",
      },
    },
    authByProtocol: {
      mcp: {
        status: "required",
        entries: [
          {
            id: "user",
            label: "User OAuth",
            use: [
              {
                id: "connect_user",
                mechanics: { source: "connect", connector: "mcp.linear.app/my-agent" },
              },
            ],
            basis: CURATED_BASIS,
          },
          {
            id: "app",
            label: "App OAuth",
            use: [
              {
                id: "connect_app",
                mechanics: {
                  source: "connect",
                  connector: "mcp.linear.app/my-agent",
                  principalType: "app",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
        ],
      },
    },
    mcpTransport: "sse",
  },
  notion: {
    categories: ["productivity", "knowledge"],
    keywords: ["docs", "wiki", "database", "oauth", "connect"],
    credentials: {
      connect_user: {
        type: "connect_user",
        label: "Notion user OAuth",
        connector: "mcp.notion.com/my-agent",
        service: "https://mcp.notion.com/mcp",
      },
      connect_app: {
        type: "connect_app",
        label: "Notion app connection",
        connector: "mcp.notion.com/my-agent",
        service: "https://mcp.notion.com/mcp",
      },
      connect_jwt: {
        type: "connect_jwt_bearer",
        label: "Notion JWT bearer",
        connector: "mcp.notion.com/my-agent",
        service: "https://mcp.notion.com/mcp",
      },
    },
    authByProtocol: {
      mcp: {
        status: "required",
        entries: [
          {
            id: "user",
            label: "User OAuth",
            use: [
              {
                id: "connect_user",
                mechanics: { source: "connect", connector: "mcp.notion.com/my-agent" },
              },
            ],
            basis: CURATED_BASIS,
          },
          {
            id: "app",
            label: "App OAuth",
            use: [
              {
                id: "connect_app",
                mechanics: {
                  source: "connect",
                  connector: "mcp.notion.com/my-agent",
                  principalType: "app",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
          {
            id: "jwtBearer",
            label: "JWT bearer",
            use: [
              {
                id: "connect_jwt",
                mechanics: {
                  source: "connect",
                  connector: "mcp.notion.com/my-agent",
                  principalType: "jwt-bearer",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
        ],
      },
      openapi: {
        status: "required",
        entries: [
          {
            id: "user",
            label: "User OAuth",
            use: [
              {
                id: "connect_user",
                mechanics: {
                  source: "http",
                  in: "header",
                  headerName: "Authorization",
                  scheme: "Bearer",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
          {
            id: "app",
            label: "App OAuth",
            use: [
              {
                id: "connect_app",
                mechanics: {
                  source: "http",
                  in: "header",
                  headerName: "Authorization",
                  scheme: "Bearer",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
          {
            id: "jwtBearer",
            label: "JWT bearer",
            use: [
              {
                id: "connect_jwt",
                mechanics: {
                  source: "http",
                  in: "header",
                  headerName: "Authorization",
                  scheme: "Bearer",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
        ],
      },
    },
    mcpTransport: "streamable-http",
  },
  datadog: {
    categories: ["observability"],
    keywords: ["metrics", "logs", "monitors", "incidents", "jwt", "connect"],
    credentials: {
      connect_jwt: {
        type: "connect_jwt_bearer",
        label: "Datadog JWT bearer",
        connector: "mcp.datadoghq.com/my-agent",
        service: "https://mcp.datadoghq.com/api/mcp",
      },
    },
    authByProtocol: {
      mcp: {
        status: "required",
        entries: [
          {
            id: "jwtBearer",
            label: "JWT bearer",
            use: [
              {
                id: "connect_jwt",
                mechanics: {
                  source: "connect",
                  connector: "mcp.datadoghq.com/my-agent",
                  principalType: "jwt-bearer",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
        ],
      },
    },
    mcpTransport: "streamable-http",
  },
  honeycomb: {
    categories: ["observability"],
    keywords: ["traces", "queries", "datasets", "jwt", "connect"],
    credentials: {
      connect_jwt: {
        type: "connect_jwt_bearer",
        label: "Honeycomb JWT bearer",
        connector: "mcp.honeycomb.io/my-agent",
        service: "https://mcp.honeycomb.io/mcp",
      },
    },
    authByProtocol: {
      mcp: {
        status: "required",
        entries: [
          {
            id: "jwtBearer",
            label: "JWT bearer",
            use: [
              {
                id: "connect_jwt",
                mechanics: {
                  source: "connect",
                  connector: "mcp.honeycomb.io/my-agent",
                  principalType: "jwt-bearer",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
        ],
      },
    },
    mcpTransport: "streamable-http",
  },
  stripe: {
    categories: ["payments"],
    keywords: ["payments", "billing", "customers", "subscriptions", "mcp", "openapi"],
    credentials: {
      api_key: bearerCredential(
        "Stripe restricted API key",
        "STRIPE_API_KEY",
        "A Stripe restricted API key or secret key with the scopes this agent needs.",
      ),
    },
    authByProtocol: {
      mcp: httpHeaderAuth("apiKey", "API key", "api_key", "Bearer"),
      openapi: httpHeaderAuth("apiKey", "API key", "api_key", "Bearer"),
    },
    mcpTransport: "streamable-http",
  },
  sentry: {
    categories: ["observability"],
    keywords: [
      "errors",
      "issues",
      "events",
      "projects",
      "releases",
      "mcp",
      "openapi",
      "oauth",
      "connect",
    ],
    credentials: {
      connect_user: {
        type: "connect_user",
        label: "Sentry user OAuth",
        connector: "mcp.sentry.dev/my-agent",
        service: "https://mcp.sentry.dev/mcp",
      },
      api_key: bearerCredential(
        "Sentry auth token",
        "SENTRY_ACCESS_TOKEN",
        "A Sentry user or organization auth token with the scopes this agent needs.",
      ),
    },
    authByProtocol: {
      // mcp.sentry.dev is a full OAuth authorization server (authorize, token,
      // and dynamic client registration endpoints); direct auth tokens remain
      // supported through Sentry's non-standard `Sentry-Bearer` scheme.
      mcp: {
        status: "required",
        entries: [
          {
            id: "user",
            label: "User OAuth",
            use: [
              {
                id: "connect_user",
                mechanics: { source: "connect", connector: "mcp.sentry.dev/my-agent" },
              },
            ],
            basis: CURATED_BASIS,
          },
          {
            id: "apiKey",
            label: "API key",
            use: [
              {
                id: "api_key",
                mechanics: {
                  source: "http",
                  in: "header",
                  headerName: "Authorization",
                  scheme: "Sentry-Bearer",
                },
              },
            ],
            basis: CURATED_BASIS,
          },
        ],
      },
      openapi: httpHeaderAuth("apiKey", "API key", "api_key", "Bearer"),
    },
    mcpTransport: "streamable-http",
  },
  "github-rest": {
    categories: ["developer tools"],
    keywords: ["github", "repositories", "issues", "pull requests", "actions", "openapi"],
    credentials: {
      api_key: bearerCredential(
        "GitHub token",
        "GITHUB_TOKEN",
        "A GitHub fine-grained personal access token or app token.",
      ),
    },
    authByProtocol: {
      openapi: httpHeaderAuth("apiKey", "API key", "api_key", "Bearer"),
    },
  },
  asana: {
    categories: ["project management", "productivity"],
    keywords: ["tasks", "projects", "portfolios", "workspaces", "openapi"],
    credentials: {
      api_key: bearerCredential(
        "Asana access token",
        "ASANA_ACCESS_TOKEN",
        "An Asana personal access token or OAuth access token.",
      ),
    },
    authByProtocol: {
      openapi: httpHeaderAuth("apiKey", "API key", "api_key", "Bearer"),
    },
  },
  jira: {
    categories: ["project management", "engineering"],
    keywords: ["jira", "issues", "projects", "workflows", "atlassian", "openapi"],
    credentials: {
      basic: basicCredential("Jira API token", {
        JIRA_EMAIL: {
          description: "The Atlassian account email for the API token.",
        },
        JIRA_API_TOKEN: {
          secret: true,
          description: "A Jira Cloud API token.",
        },
      }),
    },
    authByProtocol: {
      openapi: httpHeaderAuth("basic", "Basic auth", "basic", "Basic"),
    },
  },
  "slack-web-api": {
    categories: ["communication"],
    keywords: ["slack", "messages", "channels", "users", "files", "openapi"],
    credentials: {
      api_key: bearerCredential(
        "Slack bot token",
        "SLACK_BOT_TOKEN",
        "A Slack bot token with the Web API scopes this agent needs.",
      ),
    },
    authByProtocol: {
      openapi: httpHeaderAuth("apiKey", "API key", "api_key", "Bearer"),
    },
  },
  "twilio-api": {
    categories: ["communication"],
    keywords: ["twilio", "sms", "calls", "phone numbers", "accounts", "openapi"],
    credentials: {
      basic: basicCredential("Twilio account credentials", {
        TWILIO_ACCOUNT_SID: {
          description: "The Twilio account SID.",
        },
        TWILIO_AUTH_TOKEN: {
          secret: true,
          description: "The Twilio auth token for the account SID.",
        },
      }),
    },
    authByProtocol: {
      openapi: httpHeaderAuth("basic", "Basic auth", "basic", "Basic"),
    },
  },
};

function authForSurface(slug: string, protocol: ConnectionProtocol): ConnectionSurfaceAuth {
  return CONNECTION_METADATA[slug]?.authByProtocol[protocol] ?? { status: "unknown" };
}

function buildConnectionSurfaces(
  entry: IntegrationEntry,
  identity: ConnectionIdentity,
): ConnectionSurfaceRecord[] {
  const surfaces: ConnectionSurfaceRecord[] = [];
  if (identity.mcp) {
    surfaces.push({
      slug: "mcp",
      type: "mcp",
      name: `${entry.name} MCP`,
      description: identity.description,
      docsHref: "/docs/connections",
      basis: CURATED_BASIS,
      auth: authForSurface(entry.slug, "mcp"),
      scaffoldable: entry.surfaces.scaffoldable,
      url: identity.mcp.url,
      headers: identity.mcp.headers,
      transport: CONNECTION_METADATA[entry.slug]?.mcpTransport,
    });
  }
  if (identity.openapi) {
    surfaces.push({
      slug: "openapi",
      type: "openapi",
      name: `${entry.name} OpenAPI`,
      description: identity.description,
      docsHref: "/docs/connections",
      basis: CURATED_BASIS,
      auth: authForSurface(entry.slug, "openapi"),
      scaffoldable: entry.surfaces.scaffoldable,
      spec: identity.openapi.spec,
      baseUrl: identity.openapi.baseUrl,
      headers: identity.openapi.headers,
    });
  }
  return surfaces;
}

function buildConnectionIntegrationRecord(entry: IntegrationEntry): ConnectionIntegrationRecord {
  if (entry.connection === undefined) {
    throw new Error(`Catalog connection "${entry.slug}" is missing its connection identity.`);
  }
  const metadata = CONNECTION_METADATA[entry.slug];
  return {
    slug: entry.slug,
    name: entry.name,
    tagline: entry.tagline,
    categories: metadata?.categories,
    keywords: metadata?.keywords,
    basis: CURATED_BASIS,
    credentials: metadata?.credentials,
    surfaces: buildConnectionSurfaces(entry, entry.connection),
    availability: {
      gallery: entry.surfaces.gallery,
      docs: entry.surfaces.gallery,
      cli: entry.surfaces.scaffoldable,
      json: true,
    },
  };
}

const CONNECTION_INTEGRATION_RECORDS: readonly ConnectionIntegrationRecord[] = connectionEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildConnectionIntegrationRecord);

const CONNECTION_RECORDS_BY_SLUG = new Map(
  CONNECTION_INTEGRATION_RECORDS.map((entry) => [entry.slug, entry]),
);

/** Rich MCP/OpenAPI-only integration records for the dynamic integrations page. */
export function connectionIntegrationRecords(): ConnectionIntegrationRecord[] {
  return [...CONNECTION_INTEGRATION_RECORDS];
}

/** Returns one rich MCP/OpenAPI integration record by slug. */
export function getConnectionIntegrationRecord(
  slug: string,
): ConnectionIntegrationRecord | undefined {
  return CONNECTION_RECORDS_BY_SLUG.get(slug);
}

/** Returns all connection surfaces of a protocol in catalog order. */
export function connectionSurfacesByProtocol(
  protocol: ConnectionProtocol,
): Array<{ integration: ConnectionIntegrationRecord; surface: ConnectionSurfaceRecord }> {
  return CONNECTION_INTEGRATION_RECORDS.flatMap((integration) =>
    integration.surfaces
      .filter((surface) => surface.type === protocol)
      .map((surface) => ({ integration, surface })),
  );
}
