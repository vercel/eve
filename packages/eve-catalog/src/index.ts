/**
 * Shared identity for eve integrations. This package is the single source of
 * truth for *which* integrations exist (channels, connections, and extensions)
 * and how a connection is wired (transport + model-facing description).
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
export type IntegrationKind = "channel" | "connection" | "extension";

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
 * Web Chat for channels, and every curated connection. The remaining
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
    tagline: "Put your agent on a phone number: SMS and speech-transcribed calls.",
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
    name: "Web Chat",
    kind: "channel",
    tagline: "Embed a first-party web chat UI backed by your agent.",
    surfaces: { scaffoldable: true, gallery: true },
  },
  {
    slug: "chat-sdk-gchat",
    name: "Google Chat",
    kind: "channel",
    tagline: "Google Chat spaces and DMs via the Chat SDK.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "chat-sdk-whatsapp",
    name: "WhatsApp",
    kind: "channel",
    tagline: "Customer messaging through WhatsApp Business Cloud via the Chat SDK.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "chat-sdk-x",
    name: "X",
    kind: "channel",
    tagline: "Public mentions and DMs on X via the Chat SDK.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "chat-sdk-messenger",
    name: "Messenger",
    kind: "channel",
    tagline: "Facebook Messenger bots with templates, buttons, and reactions via the Chat SDK.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "chat-sdk-zernio",
    name: "Zernio",
    kind: "channel",
    tagline: "Reach seven social and messaging platforms through one Zernio integration.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "chat-sdk-velt",
    name: "Velt",
    kind: "channel",
    tagline: "Add agents to anchored comments across documents, canvases, PDFs, and video.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "chat-sdk-sendblue",
    name: "Sendblue",
    kind: "channel",
    tagline: "Send and receive iMessage, SMS, and RCS through Sendblue.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "chat-sdk-novu",
    name: "Novu",
    kind: "channel",
    tagline: "Reach Slack, Teams, WhatsApp, Telegram, and email through Novu.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "agent-browser",
    name: "agent-browser",
    kind: "extension",
    tagline: "Add browser automation tools backed by agent-browser to an eve agent.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "browserbase",
    name: "Browserbase",
    kind: "extension",
    tagline: "Search, fetch, and automate the web with Browserbase and Stagehand.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "github-tools",
    name: "GitHub Tools",
    kind: "extension",
    tagline: "Add scoped GitHub tools with Vercel Connect authentication and approval rules.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "jetty",
    name: "Jetty",
    kind: "extension",
    tagline: "Grade agent turns, compare experiments, and store durable evaluation trajectories.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "kernel",
    name: "Kernel",
    kind: "extension",
    tagline: "Add a Kernel cloud browser and browser automation skills to an eve agent.",
    surfaces: { scaffoldable: false, gallery: true },
  },
  {
    slug: "browser-use",
    name: "Browser Use",
    kind: "connection",
    tagline: "Run managed browser automation tasks through Browser Use's MCP server.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description:
        "Browser Use: run browser automation tasks, inspect sessions, and manage browser profiles.",
      mcp: { url: "https://api.browser-use.com/v3/mcp" },
    },
  },
  {
    slug: "vercel",
    name: "Vercel",
    kind: "connection",
    tagline: "Manage Vercel projects, deployments, and logs through Vercel's MCP server.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description:
        "Vercel: manage projects and deployments, inspect logs, and search documentation.",
      mcp: { url: "https://mcp.vercel.com" },
    },
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
    slug: "airtable",
    name: "Airtable",
    kind: "connection",
    tagline: "Bases, tables, and records through Airtable's MCP server.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Airtable: bases, tables, and records.",
      mcp: { url: "https://mcp.airtable.com/mcp" },
    },
  },
  {
    slug: "bitly",
    name: "Bitly",
    kind: "connection",
    tagline: "Shorten links, generate QR Codes, and track performance.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Bitly: shorten links, generate QR Codes, and track link performance.",
      mcp: { url: "https://api-ssl.bitly.com/v4/mcp" },
    },
  },
  {
    slug: "brex",
    name: "Brex",
    kind: "connection",
    tagline: "Expenses, cards, and cash through Brex's finance automation.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Brex: expenses, cards, budgets, and cash.",
      mcp: { url: "https://api.brex.com/mcp" },
    },
  },
  {
    slug: "candid",
    name: "Candid",
    kind: "connection",
    tagline: "Research nonprofits and funders using Candid's data.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Candid: research nonprofits, funders, and grants.",
      mcp: { url: "https://mcp.candid.org/mcp" },
    },
  },
  {
    slug: "clickhouse",
    name: "ClickHouse",
    kind: "connection",
    tagline: "Query and explore your ClickHouse Cloud data.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "ClickHouse Cloud: query and explore databases and tables.",
      mcp: { url: "https://mcp.clickhouse.cloud/mcp" },
    },
  },
  {
    slug: "cloudinary",
    name: "Cloudinary",
    kind: "connection",
    tagline: "Manage, transform, and deliver your images and videos.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Cloudinary: manage, transform, and deliver image and video assets.",
      mcp: { url: "https://asset-management.mcp.cloudinary.com/sse" },
    },
  },
  {
    slug: "coda",
    name: "Coda",
    kind: "connection",
    tagline: "Create, search, and update docs and tables.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Coda: create, search, and update docs and tables.",
      mcp: { url: "https://coda.io/apis/mcp" },
    },
  },
  {
    slug: "egnyte",
    name: "Egnyte",
    kind: "connection",
    tagline: "Securely access and analyze Egnyte content.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Egnyte: search, access, and analyze governed content.",
      mcp: { url: "https://mcp-server.egnyte.com/mcp" },
    },
  },
  {
    slug: "embat",
    name: "Embat",
    kind: "connection",
    tagline: "Ask Embat about cash, debt, payments, and accounting.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Embat: cash, debt, payments, and accounting.",
      mcp: { url: "https://tellme.embat.io/mcp" },
    },
  },
  {
    slug: "hugging-face",
    name: "Hugging Face",
    kind: "connection",
    tagline: "Access the Hugging Face Hub and thousands of Gradio apps.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Hugging Face: models, datasets, Spaces, and Gradio apps on the Hub.",
      mcp: { url: "https://huggingface.co/mcp?login&gradio=none" },
    },
  },
  {
    slug: "local-falcon",
    name: "Local Falcon",
    kind: "connection",
    tagline: "AI visibility and local search intelligence.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Local Falcon: local search rankings and AI visibility reports.",
      mcp: { url: "https://mcp.localfalcon.com" },
    },
  },
  {
    slug: "make",
    name: "Make",
    kind: "connection",
    tagline: "Run Make scenarios and manage your Make account.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Make: run scenarios and manage automations.",
      mcp: { url: "https://mcp.make.com" },
    },
  },
  {
    slug: "manufact",
    name: "Manufact",
    kind: "connection",
    tagline: "Deploy and monitor MCP servers with Manufact.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Manufact: deploy and monitor MCP servers.",
      mcp: { url: "https://mcp.manufact.com/mcp" },
    },
  },
  {
    slug: "mem0",
    name: "Mem0",
    kind: "connection",
    tagline: "Persistent memory for AI agents and assistants.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Mem0: store and retrieve persistent agent memory.",
      mcp: { url: "https://mcp.mem0.ai/mcp" },
    },
  },
  {
    slug: "miro",
    name: "Miro",
    kind: "connection",
    tagline: "Access and create content on Miro boards.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Miro: read and create content on boards.",
      mcp: { url: "https://mcp.miro.com/" },
    },
  },
  {
    slug: "mixpanel",
    name: "Mixpanel",
    kind: "connection",
    tagline: "Analyze, query, and manage your Mixpanel data.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Mixpanel: analyze, query, and manage analytics data.",
      mcp: { url: "https://mcp.mixpanel.com/mcp" },
    },
  },
  {
    slug: "netlify",
    name: "Netlify",
    kind: "connection",
    tagline: "Create, deploy, manage, and secure websites on Netlify.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Netlify: create, deploy, manage, and secure sites.",
      mcp: { url: "https://netlify-mcp.netlify.app/mcp" },
    },
  },
  {
    slug: "oreilly",
    name: "O'Reilly",
    kind: "connection",
    tagline: "Discover O'Reilly's expert learning content.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "O'Reilly: search books, courses, and learning content.",
      mcp: { url: "https://api.oreilly.com/api/content-discovery/v1/mcp/" },
    },
  },
  {
    slug: "planetscale",
    name: "PlanetScale",
    kind: "connection",
    tagline: "Authenticated access to your PlanetScale Postgres and MySQL databases.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "PlanetScale: query Postgres and MySQL databases.",
      mcp: { url: "https://mcp.pscale.dev/mcp/planetscale" },
    },
  },
  {
    slug: "posthog",
    name: "PostHog",
    kind: "connection",
    tagline: "Query, analyze, and manage your PostHog insights.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "PostHog: insights, events, and feature flags.",
      mcp: { url: "https://mcp.posthog.com/mcp" },
    },
  },
  {
    slug: "postman",
    name: "Postman",
    kind: "connection",
    tagline: "Give API context to your coding agents with Postman.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Postman: APIs, collections, and workspaces.",
      mcp: { url: "https://mcp.postman.com/minimal" },
    },
  },
  {
    slug: "razorpay",
    name: "Razorpay",
    kind: "connection",
    tagline: "Razorpay payments, settlements, and dashboard data.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Razorpay: payments, settlements, and dashboard data.",
      mcp: { url: "https://mcp.razorpay.com/mcp" },
    },
  },
  {
    slug: "sentry",
    name: "Sentry",
    kind: "connection",
    tagline: "Search, query, and debug errors intelligently.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Sentry: search, query, and debug errors and issues.",
      mcp: { url: "https://mcp.sentry.dev/mcp" },
    },
  },
  {
    slug: "similarweb",
    name: "Similarweb",
    kind: "connection",
    tagline: "Real-time web, mobile app, and market data.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Similarweb: web traffic, app, and market intelligence data.",
      mcp: { url: "https://mcp.similarweb.com" },
    },
  },
  {
    slug: "stripe",
    name: "Stripe",
    kind: "connection",
    tagline: "Payment processing and financial infrastructure tools.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Stripe: payments, customers, billing, and financial infrastructure.",
      mcp: { url: "https://mcp.stripe.com" },
    },
  },
  {
    slug: "supabase",
    name: "Supabase",
    kind: "connection",
    tagline: "Manage databases, authentication, and storage.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Supabase: databases, authentication, and storage.",
      mcp: { url: "https://mcp.supabase.com/mcp" },
    },
  },
  {
    slug: "ticket-tailor",
    name: "Ticket Tailor",
    kind: "connection",
    tagline: "Manage tickets, orders, and events with Ticket Tailor.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Ticket Tailor: events, tickets, and orders.",
      mcp: { url: "https://mcp.tickettailor.ai/mcp" },
    },
  },
  {
    slug: "ticktick",
    name: "TickTick",
    kind: "connection",
    tagline: "Search, create, and manage your tasks and habits in TickTick.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "TickTick: tasks, habits, and lists.",
      mcp: { url: "https://mcp.ticktick.com" },
    },
  },
  {
    slug: "todoist",
    name: "Todoist",
    kind: "connection",
    tagline: "Search, complete, and manage your tasks in Todoist.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Todoist: search, complete, and manage tasks.",
      mcp: { url: "https://ai.todoist.net/mcp" },
    },
  },
  {
    slug: "webflow",
    name: "Webflow",
    kind: "connection",
    tagline: "Manage Webflow CMS, pages, assets, and sites.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Webflow: CMS items, pages, assets, and sites.",
      mcp: { url: "https://mcp.webflow.com/mcp" },
    },
  },
  {
    slug: "wix",
    name: "Wix",
    kind: "connection",
    tagline: "Manage and build sites and apps on Wix.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Wix: manage and build sites and apps.",
      mcp: { url: "https://mcp.wix.com/mcp" },
    },
  },
  {
    slug: "zapier",
    name: "Zapier",
    kind: "connection",
    tagline: "Automate workflows across thousands of apps.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Zapier: run and manage automations across apps.",
      mcp: { url: "https://mcp.zapier.com/api/v1/connect" },
    },
  },
  {
    slug: "zomato",
    name: "Zomato",
    kind: "connection",
    tagline: "Online food ordering and delivery through Zomato.",
    surfaces: { scaffoldable: false, gallery: true },
    connection: {
      description: "Zomato: food ordering and delivery.",
      mcp: { url: "https://mcp-server.zomato.com/mcp" },
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

/** All extension entries, in catalog order. */
export function extensionEntries(): IntegrationEntry[] {
  return integrationsByKind("extension");
}
