import {
  type ConnectionCredential,
  type ConnectionIntegrationRecord,
  type IntegrationEntry,
  type ConnectionSurfaceRecord,
  channelEntries,
  connectionIntegrationRecords,
} from "@vercel/eve-catalog";
import generatedMcpCatalog from "./generated-mcp-catalog.json";
import generatedOpenApiCatalog from "./generated-openapi-catalog.json";
import type { LogoKey } from "./logos";

/**
 * The docs integration gallery layers presentation (logo, keywords, setup
 * markdown, auth modes) on top of the shared identity catalog
 * (`@vercel/eve-catalog`). Identity — slug, name, kind, tagline, and a
 * connection's transport + model-facing description — comes from the catalog
 * and is never re-declared here; this module owns only the docs-facing overlay,
 * keyed by slug.
 */

export type IntegrationType = "channel" | "connection";

/** Wire protocol and transport identity types are owned by the shared catalog. */
export type { ConnectionProtocol, McpTransport, OpenApiTransport } from "@vercel/eve-catalog";
import type { ConnectionProtocol } from "@vercel/eve-catalog";

/**
 * Which Vercel Connect token subject a connection authenticates as. Every mode
 * is Connect-managed: `user` (per-user OAuth, the default), `app` (one shared
 * app installation), and `jwtBearer` (a JWT bearer assertion whose subject maps
 * to a principal your IdP recognizes).
 */
export type AuthMode = "user" | "app" | "jwtBearer" | "apiKey" | "basic";

/**
 * Structured description of a connection consumed by the detail page to
 * generate Install, Quick start, and Configure content. Transport (`mcp`,
 * `openapi`) and `description` are filled from the shared catalog identity;
 * `authModes`, `connector`, and `configureNote` are the docs-only overlay.
 */
export interface ConnectionSpec {
  /** Vercel Connect connector UID; defaults to the integration slug. */
  connector?: string;
  /** Supported auth modes in display order; the first is the default. */
  authModes: AuthMode[];
  /** Model-facing description; defaults to the integration tagline. */
  description?: string;
  mcp?: Extract<ConnectionSurfaceRecord, { type: "mcp" }>;
  openapi?: Extract<ConnectionSurfaceRecord, { type: "openapi" }>;
  credentials?: Record<string, ConnectionCredential>;
  surfaces: ConnectionSurface[];
  /** Optional one-line, provider-specific configure note. Keep it short. */
  configureNote?: string;
}

export interface ConnectionSurface {
  protocol: ConnectionProtocol;
  name: string;
  description?: string;
  endpointLabel: string;
  endpointValue: string;
  authModes: AuthMode[];
  authLabels: string[];
  scaffoldable: boolean;
  basisLabel: string;
  headers?: Record<string, string>;
}

export interface Integration {
  /** URL slug and lookup key, derived once and reused everywhere. */
  slug: string;
  name: string;
  type: IntegrationType;
  /** Protocol badges shown on the gallery card (connections only). */
  protocols?: ConnectionProtocol[];
  /** One-line summary shown on the gallery card. */
  tagline: string;
  /** Brand logo key from `lib/integrations/logos`. */
  logo: LogoKey;
  /**
   * Provider domain for generated entries; when set, the UI renders the
   * domain's favicon (via `/api/logo/[domain]`) instead of the `logo` key.
   */
  logoDomain?: string;
  /** Canonical reference doc for deeper details. */
  docsHref: string;
  /** Searchable keywords beyond the name. */
  keywords?: string[];
  /**
   * Channels author their setup as markdown. Connections leave these unset
   * and supply a `connection` spec, from which content is generated.
   */
  install?: string;
  quickStart?: string;
  configure?: string;
  /** Structured connection spec; present only for `type: "connection"`. */
  connection?: ConnectionSpec;
  surfaces?: ConnectionSurface[];
  source?: "curated" | "generated";
  /** Registry popularity score; orders the generated directory, most-known first. */
  popularity?: number;
}

interface GeneratedMcpRecord {
  slug: string;
  name: string;
  provider: string;
  domain: string;
  rootDomain: string;
  tagline: string;
  url: string;
  transport: "http" | "sse";
  authHint: "none" | "oauth" | "headers" | "required" | "unknown";
  /** `detected` when an unauthenticated probe confirmed the strategy. */
  authBasis: "declared" | "detected";
  authHeaders: { name: string; description?: string; secret: boolean }[];
  popularity: number;
  docsHref: string;
  categories: string[];
  feeds: string[];
  source: string;
  sourceUrl: string;
  keywords: string[];
}

interface GeneratedOpenApiRecord {
  slug: string;
  name: string;
  provider: string;
  tagline: string;
  specUrl: string;
  docsHref: string;
  originId: string;
  version?: string;
  popularity?: number;
  source: string;
  sourceUrl: string;
  keywords: string[];
}

/** Docs presentation overlay shared by every integration kind. */
interface Presentation {
  logo: LogoKey;
  docsHref: string;
  keywords?: string[];
}

/** Channel overlay: presentation plus hand-authored setup markdown. */
interface ChannelPresentation extends Presentation {
  install: string;
  quickStart: string;
  configure: string;
}

/** Connection overlay: presentation plus Connect auth/config details. */
interface ConnectionPresentation extends Presentation {
  authModes: AuthMode[];
  connector?: string;
  configureNote?: string;
}

const channelPresentations: Record<string, ChannelPresentation> = {
  slack: {
    logo: "slack",
    docsHref: "/docs/channels/slack",
    keywords: ["chat", "messaging", "bot", "webhook"],
    install: `The eve CLI scaffolds the channel for you. \`eve channels add slack\` writes \`agent/channels/slack.ts\`, adds \`@vercel/connect\`, and runs the Connect setup flow:

\`\`\`bash
eve channels add slack
\`\`\`

To wire it up by hand instead, install the framework and the Connect SDK. Slack channels use [Vercel Connect](https://vercel.com/docs/connect) for both the outbound bot token and inbound webhook verification:

\`\`\`bash
npm install eve@latest @vercel/connect
\`\`\``,
    quickStart: `Create \`agent/channels/slack.ts\`. The channel name is derived from the filename, so no \`name\` field is needed:

\`\`\`ts
// agent/channels/slack.ts
import { slackChannel } from "eve/channels/slack";
import { connectSlackCredentials } from "@vercel/connect/eve";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
});
\`\`\`

Link the project and pull OIDC env vars so Connect can authenticate locally:

\`\`\`bash
vercel link
vercel env pull
\`\`\``,
    configure: `Create a Slack Connect client and copy its UID (for example \`slack/my-agent\`), then attach this project as the webhook trigger destination at the route eve serves (\`/eve/v1/slack\`):

\`\`\`bash
vercel connect create slack --triggers
\`\`\`

The channel handles mentions, DMs, typing indicators, delivery, and human-in-the-loop consent with sensible defaults. See the [Slack channel docs](/docs/channels/slack) for customizing each behavior.`,
  },
  discord: {
    logo: "discord",
    docsHref: "/docs/channels/discord",
    keywords: ["chat", "messaging", "bot", "guild"],
    install: `Install the framework. The Discord channel ships with it:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `Create \`agent/channels/discord.ts\`:

\`\`\`ts
// agent/channels/discord.ts
import { discordChannel } from "eve/channels/discord";

export default discordChannel({
  botToken: () => process.env.DISCORD_BOT_TOKEN!,
  publicKey: () => process.env.DISCORD_PUBLIC_KEY!,
});
\`\`\``,
    configure: `Create a Discord application, add a bot, and set the interactions endpoint URL to the route eve serves (\`/eve/v1/discord\`). Provide the bot token and public key through environment variables. See the [Discord channel docs](/docs/channels/discord) for intents and slash-command setup.`,
  },
  teams: {
    logo: "teams",
    docsHref: "/docs/channels/teams",
    keywords: ["chat", "messaging", "bot", "microsoft"],
    install: `Install the framework:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `Create \`agent/channels/teams.ts\`:

\`\`\`ts
// agent/channels/teams.ts
import { teamsChannel } from "eve/channels/teams";

export default teamsChannel({
  appId: () => process.env.TEAMS_APP_ID!,
  appPassword: () => process.env.TEAMS_APP_PASSWORD!,
});
\`\`\``,
    configure: `Register an Azure Bot, configure the messaging endpoint to eve's route (\`/eve/v1/teams\`), and supply the app ID and password via environment variables. See the [Teams channel docs](/docs/channels/teams) for the full provisioning checklist.`,
  },
  telegram: {
    logo: "telegram",
    docsHref: "/docs/channels/telegram",
    keywords: ["chat", "messaging", "bot"],
    install: `Install the framework:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `Create \`agent/channels/telegram.ts\`:

\`\`\`ts
// agent/channels/telegram.ts
import { telegramChannel } from "eve/channels/telegram";

export default telegramChannel({
  botToken: () => process.env.TELEGRAM_BOT_TOKEN!,
});
\`\`\``,
    configure: `Create a bot with [@BotFather](https://t.me/botfather), then register the webhook to point at eve's route (\`/eve/v1/telegram\`). Store the bot token in an environment variable. See the [Telegram channel docs](/docs/channels/telegram) for group privacy and command setup.`,
  },
  twilio: {
    logo: "twilio",
    docsHref: "/docs/channels/twilio",
    keywords: ["sms", "whatsapp", "messaging", "phone"],
    install: `Install the framework:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `Create \`agent/channels/twilio.ts\`:

\`\`\`ts
// agent/channels/twilio.ts
import { twilioChannel } from "eve/channels/twilio";

export default twilioChannel({
  accountSid: () => process.env.TWILIO_ACCOUNT_SID!,
  authToken: () => process.env.TWILIO_AUTH_TOKEN!,
});
\`\`\``,
    configure: `In the Twilio console, point your messaging service or phone number webhook at eve's route (\`/eve/v1/twilio\`). Provide the account SID and auth token via environment variables. See the [Twilio channel docs](/docs/channels/twilio) for SMS vs. WhatsApp specifics.`,
  },
  github: {
    logo: "github",
    docsHref: "/docs/channels/github",
    keywords: ["issues", "pull requests", "app", "webhook", "code"],
    install: `Install the framework:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `Create \`agent/channels/github.ts\`:

\`\`\`ts
// agent/channels/github.ts
import { githubChannel } from "eve/channels/github";

export default githubChannel({
  appId: () => process.env.GITHUB_APP_ID!,
  privateKey: () => process.env.GITHUB_APP_PRIVATE_KEY!,
  webhookSecret: () => process.env.GITHUB_WEBHOOK_SECRET!,
});
\`\`\``,
    configure: `Create a GitHub App, subscribe to issue and pull-request events, and set the webhook URL to eve's route (\`/eve/v1/github\`). Provide the app ID, private key, and webhook secret through environment variables. See the [GitHub channel docs](/docs/channels/github) for required permissions.`,
  },
  "linear-agent": {
    logo: "linear",
    docsHref: "/docs/channels/linear",
    keywords: ["issues", "comments", "agent sessions", "developer preview", "webhook"],
    install: `Install the framework. The Linear channel ships with it:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `Create \`agent/channels/linear.ts\`:

\`\`\`ts
// agent/channels/linear.ts
import { linearChannel } from "eve/channels/linear";

export default linearChannel({
  credentials: {
    accessToken: () => process.env.LINEAR_AGENT_ACCESS_TOKEN!,
    webhookSecret: () => process.env.LINEAR_WEBHOOK_SECRET!,
  },
});
\`\`\``,
    configure: `Create a Linear OAuth app with Agent Session events enabled, make the app assignable and mentionable, and point the webhook at eve's route (\`/eve/v1/linear\`). Provide the app access token and webhook secret through environment variables. See the [Linear channel docs](/docs/channels/linear) for scopes and Agent Activity behavior.`,
  },
  eve: {
    logo: "eve",
    docsHref: "/docs/channels/eve",
    keywords: ["web", "chat", "ui", "embed", "frontend"],
    install: `The eve CLI scaffolds the full Next.js web chat app alongside \`agent/channels/eve.ts\`:

\`\`\`bash
eve channels add web
\`\`\`

To wire it up by hand instead, install the framework:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `The eve channel is on by default. Add \`agent/channels/eve.ts\` only when you want to override the default session routes or auth:

\`\`\`ts
// agent/channels/eve.ts
import { eveChannel } from "eve/channels/eve";

export default eveChannel();
\`\`\`

Point your frontend at the session routes eve serves (\`/eve/v1/session\`) and stream responses with the eve web client.`,
    configure: `The eve channel is the lowest-friction way to talk to your agent, with no third-party provisioning required. Layer in auth and route protection as needed. See the [eve channel docs](/docs/channels/eve) and the [Frontend guide](/docs/guides/frontend/overview).`,
  },
};

/**
 * Connection presentation overlay, keyed by catalog slug. Transport (`mcp`,
 * `openapi`) and the model-facing description come from `@vercel/eve-catalog`;
 * this carries the docs-only auth modes, optional connector UID, and configure
 * note.
 */
const connectionPresentations: Record<string, ConnectionPresentation> = {
  linear: {
    logo: "linear",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "issues", "project management", "oauth", "connect"],
    authModes: ["user", "app"],
  },
  notion: {
    logo: "notion",
    docsHref: "/docs/connections",
    keywords: ["mcp", "openapi", "docs", "wiki", "knowledge base", "connect"],
    authModes: ["user", "app", "jwtBearer"],
    configureNote:
      "The OpenAPI setup sends the required `Notion-Version` header; bump it as Notion ships new API versions.",
  },
  datadog: {
    logo: "datadog",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "observability", "metrics", "monitoring", "logs"],
    authModes: ["jwtBearer"],
    configureNote:
      "Match the MCP `url` to your Datadog site (`datadoghq.com`, `datadoghq.eu`, and so on).",
  },
  honeycomb: {
    logo: "honeycomb",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "observability", "traces", "queries"],
    authModes: ["jwtBearer"],
  },
  stripe: {
    logo: "stripe",
    docsHref: "/docs/connections",
    keywords: ["mcp", "openapi", "payments", "billing", "customers", "subscriptions"],
    authModes: ["apiKey"],
    configureNote:
      "Prefer a restricted API key with only the Stripe resources this agent should read or write.",
  },
  sentry: {
    logo: "sentry",
    docsHref: "/docs/connections",
    keywords: ["mcp", "openapi", "errors", "issues", "events", "observability", "oauth", "connect"],
    authModes: ["user", "apiKey"],
    configureNote:
      "The MCP surface supports OAuth (via Vercel Connect) or Sentry's direct-token `Sentry-Bearer` scheme; the OpenAPI surface uses a normal bearer token.",
  },
  "github-rest": {
    logo: "github",
    docsHref: "/docs/connections",
    keywords: ["openapi", "code", "issues", "pull requests", "actions", "repositories"],
    authModes: ["apiKey"],
    configureNote:
      "Use a fine-grained GitHub token when possible and keep the `X-GitHub-Api-Version` header aligned with the API version you target.",
  },
  asana: {
    logo: "asana",
    docsHref: "/docs/connections",
    keywords: ["openapi", "tasks", "projects", "portfolios", "workspaces"],
    authModes: ["apiKey"],
  },
  jira: {
    logo: "jira",
    docsHref: "/docs/connections",
    keywords: ["openapi", "issues", "projects", "workflows", "atlassian"],
    authModes: ["basic"],
    configureNote:
      "Replace `https://your-domain.atlassian.net` with the Jira Cloud site that owns the issues this agent can access.",
  },
  "slack-web-api": {
    logo: "slack",
    docsHref: "/docs/connections",
    keywords: ["openapi", "messages", "channels", "users", "files", "bot token"],
    authModes: ["apiKey"],
  },
  "twilio-api": {
    logo: "twilio",
    docsHref: "/docs/connections",
    keywords: ["openapi", "sms", "calls", "phone numbers", "whatsapp"],
    authModes: ["basic"],
  },
};

function buildChannel(entry: IntegrationEntry): Integration {
  const presentation = channelPresentations[entry.slug];
  if (presentation === undefined) {
    throw new Error(
      `Channel "${entry.slug}" is in the catalog gallery but has no docs presentation.`,
    );
  }
  return {
    slug: entry.slug,
    name: entry.name,
    type: "channel",
    tagline: entry.tagline,
    logo: presentation.logo,
    docsHref: presentation.docsHref,
    keywords: presentation.keywords,
    install: presentation.install,
    quickStart: presentation.quickStart,
    configure: presentation.configure,
    source: "curated",
  };
}

const escapeTsString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** APIs.guru's provider names are usually bare domains ("stripe.com"). */
const openApiLogoDomain = (record: GeneratedOpenApiRecord): string | undefined => {
  const provider = record.provider.toLowerCase().trim();
  if (provider === "googleapis.com") return "google.com";
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(provider) ? provider : undefined;
};

function buildGeneratedOpenApi(record: GeneratedOpenApiRecord): Integration {
  const description = record.tagline || `OpenAPI tools for ${record.name}.`;
  const connectionFile = `agent/connections/${record.slug}.ts`;
  const snippet = [
    `// ${connectionFile}`,
    `import { defineOpenAPIConnection } from "eve/connections";`,
    ``,
    `export default defineOpenAPIConnection({`,
    `  spec: "${escapeTsString(record.specUrl)}",`,
    `  description: "${escapeTsString(description)}",`,
    `  // Review the provider docs for baseUrl, headers, auth, scopes, and rate limits.`,
    `});`,
  ].join("\n");

  const integration: Integration = {
    slug: record.slug,
    name: record.name,
    type: "connection",
    tagline: description,
    protocols: ["openapi"],
    logo: "web",
    logoDomain: openApiLogoDomain(record),
    docsHref: record.docsHref,
    keywords: [
      ...record.keywords,
      record.provider,
      record.originId,
      record.version,
      record.source,
    ].filter((value): value is string => typeof value === "string" && value.length > 0),
    install: [
      "Generated OpenAPI entries are docs-only until they are reviewed and tested with eve's runtime.",
      "",
      "```bash",
      "npm install eve@latest",
      "```",
    ].join("\n"),
    quickStart: [
      `Create \`${connectionFile}\` after reviewing the provider's OpenAPI spec and auth requirements:`,
      "",
      "```ts",
      snippet,
      "```",
    ].join("\n"),
    configure: [
      `This entry was generated from the ${record.source}. Treat it as a starting point, not a verified scaffold.`,
      "",
      "Before using it in an agent, confirm the provider's base URL, authentication scheme, required scopes, write permissions, and rate limits. Once reviewed, it can be promoted into the curated catalog with concrete auth metadata.",
    ].join("\n"),
    surfaces: [
      {
        protocol: "openapi",
        name: `${record.name} OpenAPI`,
        description,
        endpointLabel: "Spec",
        endpointValue: record.specUrl,
        authModes: [],
        authLabels: ["Review auth"],
        scaffoldable: false,
        basisLabel: "Generated",
      },
    ],
    source: "generated",
  };
  if (record.popularity !== undefined) integration.popularity = record.popularity;
  return integration;
}

const generatedMcpAuthLabel: Record<GeneratedMcpRecord["authHint"], string> = {
  none: "Public",
  oauth: "OAuth",
  headers: "API key",
  required: "Auth required",
  unknown: "Review auth",
};

/** SCREAMING_SNAKE env-var prefix derived from the provider domain. */
const envPrefix = (record: GeneratedMcpRecord): string =>
  record.rootDomain
    .split(".")[0]
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "PROVIDER";

const envVarForHeader = (prefix: string, headerName: string): string => {
  if (headerName.toLowerCase() === "authorization") return `${prefix}_TOKEN`;
  const suffix = headerName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^X_/, "")
    .replace(/^_+|_+$/g, "");
  return `${prefix}_${suffix || "API_KEY"}`;
};

const headerSnippetLines = (record: GeneratedMcpRecord): string[] => {
  const prefix = envPrefix(record);
  const lines = record.authHeaders.map((header) => {
    const envVar = envVarForHeader(prefix, header.name);
    if (header.name.toLowerCase() === "authorization") {
      return `    Authorization: \`Bearer \${process.env.${envVar}}\`,`;
    }
    return `    "${header.name}": process.env.${envVar}!,`;
  });
  return [`  headers: () => ({`, ...lines, `  }),`];
};

const authSnippetLines = (record: GeneratedMcpRecord): string[] => {
  if (record.authHint === "none") {
    return [`  // Public server: no credentials required.`];
  }
  if (record.authHint === "oauth") {
    return [
      `  // Connector UID from: vercel connect create ${escapeTsString(record.domain)}`,
      `  auth: connect("${escapeTsString(record.domain)}/my-agent"),`,
    ];
  }
  if (record.authHint === "headers" && record.authHeaders.length > 0) {
    return headerSnippetLines(record);
  }
  return [`  // Review the provider docs for auth (OAuth or headers), scopes, and rate limits.`];
};

const authConfigureNote = (record: GeneratedMcpRecord): string => {
  if (record.authHint === "none") {
    return "The endpoint answered an unauthenticated MCP initialize, so no credentials are needed — still review which tools it exposes before giving it to an agent.";
  }
  if (record.authHint === "oauth") {
    return "The server advertises OAuth. Front it with a [Vercel Connect](https://vercel.com/docs/connect) client and pass `auth: connect(...)`, or complete the provider's OAuth flow yourself and send the bearer token via `headers`.";
  }
  if (record.authHint === "headers" && record.authHeaders.length > 0) {
    const list = record.authHeaders
      .map((header) =>
        header.description ? `\`${header.name}\` — ${header.description}` : `\`${header.name}\``,
      )
      .join("; ");
    return `The server expects credential headers: ${list}.`;
  }
  return "Before using it in an agent, confirm the endpoint is live and review the server's authentication (many remote MCP servers use OAuth challenges; others expect header credentials).";
};

function buildGeneratedMcp(record: GeneratedMcpRecord): Integration {
  const description = record.tagline || `Remote MCP server for ${record.name}.`;
  const connectionFile = `agent/connections/${record.slug}.ts`;
  const imports = [`import { defineMcpClientConnection } from "eve/connections";`];
  if (record.authHint === "oauth") {
    imports.unshift(`import { connect } from "@vercel/connect/eve";`);
  }
  const snippet = [
    `// ${connectionFile}`,
    ...imports,
    ``,
    `export default defineMcpClientConnection({`,
    `  url: "${escapeTsString(record.url)}",`,
    `  description: "${escapeTsString(description)}",`,
    ...authSnippetLines(record),
    `});`,
  ].join("\n");

  return {
    slug: record.slug,
    name: record.name,
    type: "connection",
    tagline: description,
    protocols: ["mcp"],
    logo: "web",
    logoDomain: record.rootDomain,
    docsHref: record.docsHref,
    keywords: [...record.keywords, record.provider, record.source].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
    install: [
      "Generated MCP entries are docs-only until they are reviewed and tested with eve's runtime.",
      "",
      "```bash",
      "npm install eve@latest",
      "```",
    ].join("\n"),
    quickStart: [
      `Create \`${connectionFile}\` after reviewing the provider's MCP server docs and auth requirements:`,
      "",
      "```ts",
      snippet,
      "```",
    ].join("\n"),
    configure: [
      `This entry was generated from the ${record.source}. Treat it as a starting point, not a verified scaffold.`,
      "",
      authConfigureNote(record),
      "",
      "Once reviewed, it can be promoted into the curated catalog with concrete auth metadata.",
    ].join("\n"),
    surfaces: [
      {
        protocol: "mcp",
        name: `${record.name} MCP`,
        description,
        endpointLabel: "Endpoint",
        endpointValue: record.url,
        authModes: [],
        authLabels: [generatedMcpAuthLabel[record.authHint] ?? "Review auth"],
        scaffoldable: false,
        basisLabel: record.authBasis === "detected" ? "Detected" : "Declared",
      },
    ],
    source: "generated",
    popularity: record.popularity,
  };
}

const authModeOrder: AuthMode[] = ["user", "app", "jwtBearer", "apiKey", "basic"];

function authModeFromEntry(id: string): AuthMode | null {
  if (id === "user" || id === "app" || id === "jwtBearer" || id === "apiKey" || id === "basic") {
    return id;
  }
  return null;
}

function sortAuthModes(modes: Iterable<AuthMode>): AuthMode[] {
  const set = new Set(modes);
  return authModeOrder.filter((mode) => set.has(mode));
}

function authModesForSurface(surface: ConnectionSurfaceRecord): AuthMode[] {
  if (surface.auth.status !== "required") return [];
  return sortAuthModes(
    surface.auth.entries
      .map((entry) => authModeFromEntry(entry.id))
      .filter((mode): mode is AuthMode => mode !== null),
  );
}

function authLabelsForSurface(surface: ConnectionSurfaceRecord): string[] {
  if (surface.auth.status === "none") return ["Public"];
  if (surface.auth.status === "unknown") return ["Unknown"];
  return surface.auth.entries.map((entry) => entry.label);
}

function basisLabel(surface: ConnectionSurfaceRecord): string {
  const via = surface.basis.via;
  return via.charAt(0).toUpperCase() + via.slice(1);
}

function buildSurfaceView(surface: ConnectionSurfaceRecord): ConnectionSurface {
  const base = {
    protocol: surface.type,
    name: surface.name,
    description: surface.description,
    authModes: authModesForSurface(surface),
    authLabels: authLabelsForSurface(surface),
    scaffoldable: surface.scaffoldable ?? false,
    basisLabel: basisLabel(surface),
    headers: surface.headers,
  };
  if (surface.type === "mcp") {
    return {
      ...base,
      endpointLabel: "Endpoint",
      endpointValue: surface.url,
    };
  }
  return {
    ...base,
    endpointLabel: "Spec",
    endpointValue: surface.spec,
  };
}

function buildConnection(record: ConnectionIntegrationRecord): Integration {
  const presentation = connectionPresentations[record.slug];
  if (presentation === undefined) {
    throw new Error(
      `Connection "${record.slug}" is in the catalog gallery but has no docs presentation.`,
    );
  }
  const mcp = record.surfaces.find((surface) => surface.type === "mcp");
  const openapi = record.surfaces.find((surface) => surface.type === "openapi");
  const surfaces = record.surfaces.map(buildSurfaceView);
  const authModes = sortAuthModes(surfaces.flatMap((surface) => surface.authModes));
  const spec: ConnectionSpec = {
    authModes,
    description: record.surfaces[0]?.description ?? record.tagline,
    credentials: record.credentials,
    surfaces,
  };
  if (presentation.connector !== undefined) spec.connector = presentation.connector;
  if (mcp !== undefined) spec.mcp = mcp;
  if (openapi !== undefined) spec.openapi = openapi;
  if (presentation.configureNote !== undefined) spec.configureNote = presentation.configureNote;
  return {
    slug: record.slug,
    name: record.name,
    type: "connection",
    tagline: record.tagline,
    protocols: surfaces.map((surface) => surface.protocol),
    logo: presentation.logo,
    docsHref: presentation.docsHref,
    keywords: [...(record.keywords ?? []), ...(presentation.keywords ?? [])],
    connection: spec,
    surfaces,
    source: "curated",
  };
}

export const channelIntegrations: Integration[] = channelEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildChannel);

export const connectionIntegrations: Integration[] = connectionIntegrationRecords()
  .filter((entry) => entry.availability.gallery)
  .map(buildConnection);

const hostnameOf = (value: string): string | null => {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Domains already covered by a curated MCP connection; curated always wins. */
const curatedMcpDomains = new Set(
  connectionIntegrations.flatMap((integration) =>
    (integration.surfaces ?? [])
      .filter((surface) => surface.protocol === "mcp")
      .map((surface) => hostnameOf(surface.endpointValue))
      .filter((domain): domain is string => domain !== null),
  ),
);

export const generatedMcpIntegrations: Integration[] = (generatedMcpCatalog as GeneratedMcpRecord[])
  .filter((record) => !curatedMcpDomains.has(record.domain))
  .map(buildGeneratedMcp);

export const generatedOpenApiIntegrations: Integration[] = (
  generatedOpenApiCatalog as GeneratedOpenApiRecord[]
).map(buildGeneratedOpenApi);

/** Display label for each connection protocol. */
export const protocolLabel: Record<ConnectionProtocol, string> = {
  mcp: "MCP",
  openapi: "OpenAPI",
};

/** Accent badge classes per protocol, readable in light and dark mode. */
export const protocolBadgeClassName: Record<ConnectionProtocol, string> = {
  mcp: "bg-blue-100 text-blue-900",
  openapi: "bg-purple-100 text-purple-900",
};

/** Display label for each auth mode. */
export const authModeLabel: Record<AuthMode, string> = {
  user: "User",
  app: "App",
  jwtBearer: "JWT bearer",
  apiKey: "API key",
  basic: "Basic auth",
};

/** Generated entries interleave MCP and OpenAPI, most-known services first. */
const generatedIntegrations: Integration[] = [
  ...generatedMcpIntegrations,
  ...generatedOpenApiIntegrations,
].sort(
  (a, b) =>
    (b.popularity ?? 0) - (a.popularity ?? 0) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
);

export const integrations: Integration[] = [
  ...channelIntegrations,
  ...connectionIntegrations,
  ...generatedIntegrations,
];

/**
 * Slim projection passed to the client gallery: everything the list needs to
 * render, filter, and search — without the per-entry setup markdown, which
 * would multiply the page payload by the size of the generated catalogs.
 */
export type GalleryIntegration = Pick<
  Integration,
  "slug" | "name" | "type" | "tagline" | "logo" | "logoDomain" | "keywords" | "source" | "surfaces"
>;

export const galleryIntegrations: GalleryIntegration[] = integrations.map((integration) => {
  const item: GalleryIntegration = {
    slug: integration.slug,
    name: integration.name,
    type: integration.type,
    tagline: integration.tagline,
    logo: integration.logo,
  };
  if (integration.logoDomain !== undefined) item.logoDomain = integration.logoDomain;
  if (integration.keywords !== undefined) item.keywords = integration.keywords;
  if (integration.source !== undefined) item.source = integration.source;
  if (integration.surfaces !== undefined) item.surfaces = integration.surfaces;
  return item;
});

export const getIntegration = (slug: string): Integration | undefined =>
  integrations.find((integration) => integration.slug === slug);

export const integrationSlugs = (): string[] => integrations.map((integration) => integration.slug);
