import {
  type ConnectionIdentity,
  type IntegrationEntry,
  channelEntries,
  connectionEntries,
  connectionProtocols as protocolsForIdentity,
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
    install: `The Eve CLI scaffolds the channel for you. \`eve channels add slack\` writes \`agent/channels/slack.ts\`, adds \`@vercel/connect\`, and runs the Connect setup flow:

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
    configure: `Create a Slack Connect client and copy its UID (for example \`slack/my-agent\`), then attach this project as the webhook trigger destination at the route Eve serves (\`/eve/v1/slack\`):

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
    configure: `Create a Discord application, add a bot, and set the interactions endpoint URL to the route Eve serves (\`/eve/v1/discord\`). Provide the bot token and public key through environment variables. See the [Discord channel docs](/docs/channels/discord) for intents and slash-command setup.`,
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
    configure: `Register an Azure Bot, configure the messaging endpoint to Eve's route (\`/eve/v1/teams\`), and supply the app ID and password via environment variables. See the [Teams channel docs](/docs/channels/teams) for the full provisioning checklist.`,
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
    configure: `Create a bot with [@BotFather](https://t.me/botfather), then register the webhook to point at Eve's route (\`/eve/v1/telegram\`). Store the bot token in an environment variable. See the [Telegram channel docs](/docs/channels/telegram) for group privacy and command setup.`,
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
    configure: `In the Twilio console, point your messaging service or phone number webhook at Eve's route (\`/eve/v1/twilio\`). Provide the account SID and auth token via environment variables. See the [Twilio channel docs](/docs/channels/twilio) for SMS vs. WhatsApp specifics.`,
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
    configure: `Create a GitHub App, subscribe to issue and pull-request events, and set the webhook URL to Eve's route (\`/eve/v1/github\`). Provide the app ID, private key, and webhook secret through environment variables. See the [GitHub channel docs](/docs/channels/github) for required permissions.`,
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
    configure: `Create a Linear OAuth app with Agent Session events enabled, make the app assignable and mentionable, and point the webhook at Eve's route (\`/eve/v1/linear\`). Provide the app access token and webhook secret through environment variables. See the [Linear channel docs](/docs/channels/linear) for scopes and Agent Activity behavior.`,
  },
  eve: {
    logo: "eve",
    docsHref: "/docs/channels/eve",
    keywords: ["web", "chat", "ui", "embed", "frontend"],
    install: `The Eve CLI scaffolds the full Next.js web chat app alongside \`agent/channels/eve.ts\`:

\`\`\`bash
eve channels add web
\`\`\`

To wire it up by hand instead, install the framework:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `The Eve channel is on by default. Add \`agent/channels/eve.ts\` only when you want to override the default session routes or auth:

\`\`\`ts
// agent/channels/eve.ts
import { eveChannel } from "eve/channels/eve";

export default eveChannel();
\`\`\`

Point your frontend at the session routes Eve serves (\`/eve/v1/session\`) and stream responses with the Eve web client.`,
    configure: `The Eve channel is the lowest-friction way to talk to your agent, with no third-party provisioning required. Layer in auth and route protection as needed. See the [Eve channel docs](/docs/channels/eve) and the [Frontend guide](/docs/guides/frontend/overview).`,
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
    docsHref: "/docs/connections",
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
    docsHref: "/docs/connections",
    keywords: ["mcp", "observability", "metrics", "monitoring", "logs"],
    authModes: ["jwtBearer"],
    configureNote:
      "Match the MCP `url` to your Datadog site (`datadoghq.com`, `datadoghq.eu`, and so on).",
  },
  honeycomb: {
    logo: "honeycomb",
    docsHref: "/docs/connections",
    keywords: ["mcp", "observability", "traces", "queries"],
    authModes: ["jwtBearer"],
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

const channels: Integration[] = channelEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildChannel);

const connections: Integration[] = connectionEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildConnection);

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

export const integrations: Integration[] = [...channels, ...connections];

export const getIntegration = (slug: string): Integration | undefined =>
  integrations.find((integration) => integration.slug === slug);

export const integrationSlugs = (): string[] => integrations.map((integration) => integration.slug);
