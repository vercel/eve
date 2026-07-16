import {
  type ConnectionIdentity,
  type IntegrationEntry,
  channelEntries,
  connectionEntries,
  connectionProtocols as protocolsForIdentity,
  instrumentationEntries,
} from "@vercel/eve-catalog";
import type { LogoKey } from "./logos";

/**
 * The docs integration gallery layers presentation (logo, keywords, setup
 * markdown, auth modes) on top of the shared identity catalog
 * (`@vercel/eve-catalog`). Identity — slug, name, kind, tagline, and a
 * connection's transport + model-facing description — comes from the catalog
 * and is never re-declared here; this module owns only the docs-facing overlay,
 * keyed by slug.
 */

export type IntegrationType = "channel" | "connection" | "instrumentation";

/** Wire protocol and transport identity types are owned by the shared catalog. */
export type { ConnectionProtocol, McpTransport, OpenApiTransport } from "@vercel/eve-catalog";
import type { ConnectionProtocol } from "@vercel/eve-catalog";

/**
 * Which Vercel Connect token subject a connection authenticates as. Every mode
 * is Connect-managed: `user` (per-user OAuth, the default), `app` (one shared
 * app installation), and `jwtBearer` (a JWT bearer assertion whose subject maps
 * to a principal your IdP recognizes).
 */
export type AuthMode = "user" | "app" | "jwtBearer";

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
  mcp?: ConnectionIdentity["mcp"];
  openapi?: ConnectionIdentity["openapi"];
  /** Optional one-line, provider-specific configure note. Keep it short. */
  configureNote?: string;
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
  airtable: {
    logo: "airtable",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "bases", "tables", "records", "no-code", "oauth", "connect"],
    authModes: ["user"],
  },
  bitly: {
    logo: "bitly",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "links", "qr codes", "analytics", "oauth", "connect"],
    authModes: ["user"],
  },
  brex: {
    logo: "brex",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "finance", "expenses", "cards", "spend", "oauth", "connect"],
    authModes: ["user"],
  },
  candid: {
    logo: "candid",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "nonprofits", "funders", "grants", "research", "oauth", "connect"],
    authModes: ["user"],
  },
  clickhouse: {
    logo: "clickhouse",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "sql", "analytics", "warehouse", "queries", "oauth", "connect"],
    authModes: ["user"],
  },
  cloudinary: {
    logo: "cloudinary",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "images", "videos", "assets", "media", "oauth", "connect"],
    authModes: ["user"],
  },
  coda: {
    logo: "coda",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "docs", "tables", "pages", "oauth", "connect"],
    authModes: ["user"],
  },
  egnyte: {
    logo: "egnyte",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "files", "content", "governance", "oauth", "connect"],
    authModes: ["user"],
  },
  embat: {
    logo: "embat",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "treasury", "cash", "payments", "accounting", "oauth", "connect"],
    authModes: ["user"],
  },
  "hugging-face": {
    logo: "hugging-face",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "models", "datasets", "spaces", "gradio", "ai", "oauth", "connect"],
    authModes: ["user"],
  },
  "local-falcon": {
    logo: "local-falcon",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "local seo", "rankings", "ai visibility", "oauth", "connect"],
    authModes: ["user"],
  },
  make: {
    logo: "make",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "scenarios", "workflows", "automation", "oauth", "connect"],
    authModes: ["user"],
  },
  manufact: {
    logo: "manufact",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "mcp servers", "deploy", "monitor", "oauth", "connect"],
    authModes: ["user"],
  },
  mem0: {
    logo: "mem0",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "memory", "agents", "retrieval", "ai", "oauth", "connect"],
    authModes: ["user"],
  },
  miro: {
    logo: "miro",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "boards", "whiteboard", "diagrams", "oauth", "connect"],
    authModes: ["user"],
  },
  mixpanel: {
    logo: "mixpanel",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "events", "funnels", "insights", "analytics", "oauth", "connect"],
    authModes: ["user"],
  },
  netlify: {
    logo: "netlify",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "deploys", "sites", "hosting", "oauth", "connect"],
    authModes: ["user"],
  },
  oreilly: {
    logo: "oreilly",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "books", "courses", "learning", "oauth", "connect"],
    authModes: ["user"],
  },
  planetscale: {
    logo: "planetscale",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "postgres", "mysql", "databases", "oauth", "connect"],
    authModes: ["user"],
  },
  posthog: {
    logo: "posthog",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "insights", "events", "feature flags", "analytics", "oauth", "connect"],
    authModes: ["user"],
  },
  postman: {
    logo: "postman",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "apis", "collections", "workspaces", "oauth", "connect"],
    authModes: ["user"],
  },
  razorpay: {
    logo: "razorpay",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "payments", "settlements", "oauth", "connect"],
    authModes: ["user"],
  },
  sentry: {
    logo: "sentry",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "errors", "issues", "observability", "oauth", "connect"],
    authModes: ["user"],
  },
  similarweb: {
    logo: "similarweb",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "traffic", "market data", "competitive intelligence", "oauth", "connect"],
    authModes: ["user"],
  },
  stripe: {
    logo: "stripe",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "payments", "billing", "customers", "oauth", "connect"],
    authModes: ["user"],
  },
  supabase: {
    logo: "supabase",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "postgres", "auth", "storage", "oauth", "connect"],
    authModes: ["user"],
  },
  "ticket-tailor": {
    logo: "ticket-tailor",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "tickets", "orders", "events", "oauth", "connect"],
    authModes: ["user"],
  },
  ticktick: {
    logo: "ticktick",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "tasks", "habits", "todo", "oauth", "connect"],
    authModes: ["user"],
  },
  todoist: {
    logo: "todoist",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "tasks", "projects", "todo", "oauth", "connect"],
    authModes: ["user"],
  },
  webflow: {
    logo: "webflow",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "cms", "pages", "sites", "oauth", "connect"],
    authModes: ["user"],
  },
  wix: {
    logo: "wix",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "sites", "apps", "cms", "oauth", "connect"],
    authModes: ["user"],
  },
  zapier: {
    logo: "zapier",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "zaps", "workflows", "apps", "automation", "oauth", "connect"],
    authModes: ["user"],
  },
  zomato: {
    logo: "zomato",
    docsHref: "/docs/connections/mcp",
    keywords: ["mcp", "food", "ordering", "delivery", "oauth", "connect"],
    authModes: ["user"],
  },
};

/**
 * Instrumentation overlay: presentation plus hand-authored setup markdown.
 * Instrumentation providers are OpenTelemetry backends configured in
 * `agent/instrumentation.ts`, so they follow the channel shape (markdown)
 * rather than the generated connection shape.
 */
type InstrumentationPresentation = ChannelPresentation;

const instrumentationPresentations: Record<string, InstrumentationPresentation> = {
  braintrust: {
    logo: "braintrust",
    docsHref: "/docs/guides/instrumentation",
    keywords: ["otel", "opentelemetry", "tracing", "observability", "evals", "monitoring"],
    install: `Install the framework, the Vercel OpenTelemetry wrapper, and Braintrust's exporter:

\`\`\`bash
npm install eve@latest @vercel/otel @braintrust/otel
\`\`\``,
    quickStart: `Create \`agent/instrumentation.ts\`. eve auto-discovers it and runs it at server startup, and its presence enables telemetry:

\`\`\`ts
// agent/instrumentation.ts
import { BraintrustExporter } from "@braintrust/otel";
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new BraintrustExporter({
        parent: \`project_name:\${agentName}\`,
        filterAISpans: true,
      }),
    }),
});
\`\`\``,
    configure: `Create an API key in the Braintrust dashboard and expose it as \`BRAINTRUST_API_KEY\`. Spans land in the Braintrust project named after your agent. See the [instrumentation guide](/docs/guides/instrumentation) for the trace hierarchy and the \`recordInputs\`/\`recordOutputs\` controls.`,
  },
  "sentry-instrumentation": {
    logo: "sentry",
    docsHref: "/docs/guides/instrumentation",
    keywords: ["otel", "opentelemetry", "tracing", "observability", "otlp", "errors"],
    install: `Install the framework and the Vercel OpenTelemetry wrapper. Sentry ingests OTLP directly, so no Sentry SDK is required:

\`\`\`bash
npm install eve@latest @vercel/otel
\`\`\``,
    quickStart: `Create \`agent/instrumentation.ts\` and point the OTLP exporter at your project's Sentry traces endpoint:

\`\`\`ts
// agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: process.env.SENTRY_OTLP_TRACES_ENDPOINT!,
        headers: {
          "x-sentry-auth": \`sentry sentry_key=\${process.env.SENTRY_PUBLIC_KEY}\`,
        },
      }),
    }),
});
\`\`\``,
    configure: `Copy the OTLP traces endpoint and public key from your Sentry project under **Settings → Client Keys (DSN)** and expose them as environment variables. Sentry's OTLP intake accepts traces only, and span events are dropped at ingestion. See the [instrumentation guide](/docs/guides/instrumentation) for the trace hierarchy and the \`recordInputs\`/\`recordOutputs\` controls.`,
  },
  "datadog-instrumentation": {
    logo: "datadog",
    docsHref: "/docs/guides/instrumentation",
    keywords: ["otel", "opentelemetry", "tracing", "observability", "apm", "otlp"],
    install: `Install the framework and the Vercel OpenTelemetry wrapper:

\`\`\`bash
npm install eve@latest @vercel/otel
\`\`\``,
    quickStart: `Create \`agent/instrumentation.ts\` and point the OTLP exporter at Datadog's intake for your site, authenticated with your API key:

\`\`\`ts
// agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: process.env.DATADOG_OTLP_TRACES_ENDPOINT!,
        headers: { "dd-api-key": process.env.DD_API_KEY! },
      }),
    }),
});
\`\`\``,
    configure: `Datadog's direct OTLP trace intake is site-specific (for example \`datadoghq.com\` vs \`datadoghq.eu\`) and currently in Preview; look up the endpoint for your site in Datadog's OTLP intake docs. For production, Datadog recommends routing through an OpenTelemetry Collector with the Datadog exporter instead. See the [instrumentation guide](/docs/guides/instrumentation) for the trace hierarchy and the \`recordInputs\`/\`recordOutputs\` controls.`,
  },
  "honeycomb-instrumentation": {
    logo: "honeycomb",
    docsHref: "/docs/guides/instrumentation",
    keywords: ["otel", "opentelemetry", "tracing", "observability", "queries", "otlp"],
    install: `Install the framework and the Vercel OpenTelemetry wrapper. Honeycomb ingests OTLP directly:

\`\`\`bash
npm install eve@latest @vercel/otel
\`\`\``,
    quickStart: `Create \`agent/instrumentation.ts\` and send traces to Honeycomb's OTLP endpoint with your ingest key:

\`\`\`ts
// agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: "https://api.honeycomb.io/v1/traces",
        headers: { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY! },
      }),
    }),
});
\`\`\``,
    configure: `Create an ingest key under your Honeycomb environment settings and expose it as \`HONEYCOMB_API_KEY\`. Spans arrive in a dataset named after your agent (the OTel service name). EU teams use \`https://api.eu1.honeycomb.io/v1/traces\`. See the [instrumentation guide](/docs/guides/instrumentation) for the trace hierarchy and the \`recordInputs\`/\`recordOutputs\` controls.`,
  },
  arize: {
    logo: "arize",
    docsHref: "/docs/guides/instrumentation",
    keywords: ["otel", "opentelemetry", "tracing", "llm observability", "evaluation", "otlp"],
    install: `Install the framework and the Vercel OpenTelemetry wrapper. Arize AX ingests OTLP directly:

\`\`\`bash
npm install eve@latest @vercel/otel
\`\`\``,
    quickStart: `Create \`agent/instrumentation.ts\` and send traces to Arize's OTLP endpoint with your space ID and API key:

\`\`\`ts
// agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      attributes: { "openinference.project.name": agentName },
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: "https://otlp.arize.com/v1/traces",
        headers: {
          space_id: process.env.ARIZE_SPACE_ID!,
          api_key: process.env.ARIZE_API_KEY!,
        },
      }),
    }),
});
\`\`\``,
    configure: `Copy the space ID and API key from your Arize AX space settings and expose them as \`ARIZE_SPACE_ID\` and \`ARIZE_API_KEY\`. The \`openinference.project.name\` resource attribute routes spans to a project named after your agent. See the [instrumentation guide](/docs/guides/instrumentation) for the trace hierarchy and the \`recordInputs\`/\`recordOutputs\` controls.`,
  },
  raindrop: {
    logo: "raindrop",
    docsHref: "/docs/guides/instrumentation",
    keywords: ["otel", "opentelemetry", "tracing", "observability", "ai issues", "otlp"],
    install: `Install the framework and the Vercel OpenTelemetry wrapper. Raindrop ingests OTLP directly:

\`\`\`bash
npm install eve@latest @vercel/otel
\`\`\``,
    quickStart: `Create \`agent/instrumentation.ts\` and send traces to Raindrop's OTLP endpoint with your write key:

\`\`\`ts
// agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: "https://api.raindrop.ai/v1/traces",
        headers: {
          Authorization: \`Bearer \${process.env.RAINDROP_WRITE_KEY}\`,
        },
      }),
    }),
});
\`\`\``,
    configure: `Create a write key in the Raindrop dashboard and expose it as \`RAINDROP_WRITE_KEY\`. Raindrop's Vercel AI SDK integration picks up the AI SDK spans eve emits on every turn. See the [instrumentation guide](/docs/guides/instrumentation) for the trace hierarchy and the \`recordInputs\`/\`recordOutputs\` controls.`,
  },
  jaeger: {
    logo: "jaeger",
    docsHref: "/docs/guides/instrumentation",
    keywords: ["otel", "opentelemetry", "tracing", "observability", "local", "self-hosted"],
    install: `Install the framework and the Vercel OpenTelemetry wrapper:

\`\`\`bash
npm install eve@latest @vercel/otel
\`\`\``,
    quickStart: `Create \`agent/instrumentation.ts\` and point the OTLP exporter at your Jaeger collector:

\`\`\`ts
// agent/instrumentation.ts
import { defineInstrumentation } from "eve/instrumentation";
import { OTLPHttpProtoTraceExporter, registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpProtoTraceExporter({
        url: "http://localhost:4318/v1/traces",
      }),
    }),
});
\`\`\``,
    configure: `Run Jaeger locally with Docker and open the UI at \`http://localhost:16686\`:

\`\`\`bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
\`\`\`

Point the exporter at your collector's OTLP HTTP endpoint when self-hosting. See the [instrumentation guide](/docs/guides/instrumentation) for the trace hierarchy and the \`recordInputs\`/\`recordOutputs\` controls.`,
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
  };
}

function buildConnection(entry: IntegrationEntry): Integration {
  const presentation = connectionPresentations[entry.slug];
  if (presentation === undefined) {
    throw new Error(
      `Connection "${entry.slug}" is in the catalog gallery but has no docs presentation.`,
    );
  }
  if (entry.connection === undefined) {
    throw new Error(`Catalog connection "${entry.slug}" is missing its connection identity.`);
  }
  const identity: ConnectionIdentity = entry.connection;
  const spec: ConnectionSpec = {
    authModes: presentation.authModes,
    description: identity.description,
  };
  if (presentation.connector !== undefined) spec.connector = presentation.connector;
  if (identity.mcp !== undefined) spec.mcp = identity.mcp;
  if (identity.openapi !== undefined) spec.openapi = identity.openapi;
  if (presentation.configureNote !== undefined) spec.configureNote = presentation.configureNote;
  return {
    slug: entry.slug,
    name: entry.name,
    type: "connection",
    tagline: entry.tagline,
    protocols: protocolsForIdentity(identity),
    logo: presentation.logo,
    docsHref: presentation.docsHref,
    keywords: presentation.keywords,
    connection: spec,
  };
}

function buildInstrumentation(entry: IntegrationEntry): Integration {
  const presentation = instrumentationPresentations[entry.slug];
  if (presentation === undefined) {
    throw new Error(
      `Instrumentation provider "${entry.slug}" is in the catalog gallery but has no docs presentation.`,
    );
  }
  return {
    slug: entry.slug,
    name: entry.name,
    type: "instrumentation",
    tagline: entry.tagline,
    logo: presentation.logo,
    docsHref: presentation.docsHref,
    keywords: presentation.keywords,
    install: presentation.install,
    quickStart: presentation.quickStart,
    configure: presentation.configure,
  };
}

const channels: Integration[] = channelEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildChannel);

const connections: Integration[] = connectionEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildConnection);

const instrumentation: Integration[] = instrumentationEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildInstrumentation);

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
};

export const integrations: Integration[] = [...channels, ...connections, ...instrumentation];

export const getIntegration = (slug: string): Integration | undefined =>
  integrations.find((integration) => integration.slug === slug);

export const integrationSlugs = (): string[] => integrations.map((integration) => integration.slug);
