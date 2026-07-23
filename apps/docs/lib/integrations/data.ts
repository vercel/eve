import {
  type ConnectionIdentity,
  type IntegrationEntry,
  channelEntries,
  connectionEntries,
  connectionProtocols as protocolsForIdentity,
  extensionEntries,
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

export type IntegrationType = "channel" | "connection" | "extension";

/** Wire protocol and transport identity types are owned by the shared catalog. */
export type { ConnectionProtocol, McpTransport, OpenApiTransport } from "@vercel/eve-catalog";
import type { ConnectionProtocol } from "@vercel/eve-catalog";

/**
 * How a connection authenticates. A mode uses either Vercel Connect (`user`,
 * `app`, or `jwtBearer`) or a server-side API key.
 */
export type AuthMode = "user" | "app" | "jwtBearer" | "apiKey";

export interface ApiKeySpec {
  /** Server-side environment variable containing the API key. */
  env: string;
  /** Header used to send the API key. */
  header: string;
}

/**
 * Structured description of a connection consumed by the detail page to
 * generate Install, Quick start, and Configure content. Transport (`mcp`,
 * `openapi`) and `description` are filled from the shared catalog identity;
 * `authModes`, `connector`, and `configureNote` are the docs-only overlay.
 */
export interface ConnectionSpec {
  /** Vercel Connect connector UID; defaults to the integration slug. */
  connector?: string;
  /** Service passed to `vercel connect create` when it differs from the connector UID. */
  connectorService?: string;
  /** Supported auth modes in display order; the first is the default. */
  authModes: AuthMode[];
  /** API-key wiring when `authModes` includes `apiKey`. */
  apiKey?: ApiKeySpec;
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
  /** Optional pill (e.g. "Chat SDK") shown next to the type label. */
  badge?: string;
  /** Canonical reference doc for deeper details. */
  docsHref: string;
  /** Searchable keywords beyond the name. */
  keywords?: string[];
  /**
   * Channels and extensions author their setup as markdown. Connections leave
   * these unset and supply a `connection` spec, from which content is generated.
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
  /** Optional gallery pill (e.g. "Chat SDK") shown next to the type label. */
  badge?: string;
}

/** Channel overlay: presentation plus hand-authored setup markdown. */
interface ChannelPresentation extends Presentation {
  install: string;
  quickStart: string;
  configure: string;
}

/** Extension overlay with hand-authored package setup. */
interface ExtensionPresentation extends Presentation {
  install: string;
  quickStart: string;
  configure: string;
}

/** Connection overlay: presentation plus Connect auth/config details. */
interface ConnectionPresentation extends Presentation {
  authModes: AuthMode[];
  apiKey?: ApiKeySpec;
  connector?: string;
  connectorService?: string;
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
    keywords: ["sms", "voice", "calls", "phone", "transcription"],
    install: `Install the framework:

\`\`\`bash
npm install eve@latest
\`\`\``,
    quickStart: `Create \`agent/channels/twilio.ts\`. \`allowFrom\` is required and gates who can reach the inbound hooks:

\`\`\`ts
// agent/channels/twilio.ts
import { twilioChannel } from "eve/channels/twilio";

export default twilioChannel({
  allowFrom: "+15551234567",
  messaging: { from: "+15557654321" },
});
\`\`\`

\`\`\`bash
TWILIO_ACCOUNT_SID=AC...   # required for default outbound SMS
TWILIO_AUTH_TOKEN=...      # required for inbound signature verification
\`\`\``,
    configure: `In the Twilio console, point your number's Messaging webhook at \`/eve/v1/twilio/messages\` and its Voice webhook at \`/eve/v1/twilio/voice\`. Inbound calls are answered with speech gathering, and the transcript feeds the same session SMS uses. See the [Twilio channel docs](/docs/channels/twilio) for dispatch, streaming, and voice specifics.`,
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
  "chat-sdk-gchat": {
    logo: "googlechat",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Chat SDK",
    keywords: ["chat sdk", "google chat", "spaces", "bot"],
    install: `Install eve, the Chat SDK core (\`chat\`), the Google Chat adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat @chat-adapter/gchat @chat-adapter/state-memory
\`\`\`

The in-memory state store is fine for local development; use a durable state adapter (Redis, PostgreSQL) in production so thread subscriptions survive restarts.`,
    quickStart: `Create \`agent/channels/gchat.ts\`. Register Chat SDK handlers on \`bot\`, call \`send\` to hand each turn to eve, and export the channel:

\`\`\`ts
// agent/channels/gchat.ts
import { createGoogleChatAdapter } from "@chat-adapter/gchat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: { gchat: createGoogleChatAdapter() },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

Credentials come from the \`createGoogleChatAdapter\` config or the adapter's environment variables; see the [Google Chat adapter docs](https://chat-sdk.dev/adapters/official/gchat).`,
    configure: `The adapter mounts its webhook at \`/eve/v1/gchat\`. Point your Google Chat app's HTTP endpoint at it. The adapter owns provider auth, verification, and delivery, while eve owns session dispatch, streaming, typing, and human-in-the-loop. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for routes, streaming, and state options.`,
  },
  "chat-sdk-whatsapp": {
    logo: "whatsapp",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Chat SDK",
    keywords: ["chat sdk", "whatsapp", "business cloud", "messaging"],
    install: `Install eve, the Chat SDK core (\`chat\`), the WhatsApp adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat @chat-adapter/whatsapp @chat-adapter/state-memory
\`\`\`

The in-memory state store is fine for local development; use a durable state adapter (Redis, PostgreSQL) in production so thread subscriptions survive restarts.`,
    quickStart: `Create \`agent/channels/whatsapp.ts\`. Register Chat SDK handlers on \`bot\`, call \`send\` to hand each turn to eve, and export the channel:

\`\`\`ts
// agent/channels/whatsapp.ts
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: { whatsapp: createWhatsAppAdapter() },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

Credentials come from the \`createWhatsAppAdapter\` config or the adapter's environment variables; see the [WhatsApp adapter docs](https://chat-sdk.dev/adapters/official/whatsapp).`,
    configure: `The adapter mounts its webhook at \`/eve/v1/whatsapp\`. Point your WhatsApp Business Cloud webhook at it. The adapter owns provider auth, verification, and delivery, while eve owns session dispatch, streaming, typing, and human-in-the-loop. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for routes, streaming, and state options.`,
  },
  "chat-sdk-x": {
    logo: "x",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Chat SDK",
    keywords: ["chat sdk", "x", "twitter", "mentions", "dms"],
    install: `Install eve, the Chat SDK core (\`chat\`), the X adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat @chat-adapter/x @chat-adapter/state-memory
\`\`\`

The in-memory state store is fine for local development; use a durable state adapter (Redis, PostgreSQL) in production so thread subscriptions survive restarts.`,
    quickStart: `Create \`agent/channels/x.ts\`. Register Chat SDK handlers on \`bot\`, call \`send\` to hand each turn to eve, and export the channel:

\`\`\`ts
// agent/channels/x.ts
import { createXAdapter } from "@chat-adapter/x";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: { x: createXAdapter() },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

Credentials come from the \`createXAdapter\` config or the adapter's environment variables; see the [X adapter docs](https://chat-sdk.dev/adapters/official/x).`,
    configure: `The adapter mounts its webhook at \`/eve/v1/x\`. Point your X account activity webhook at it. The adapter owns provider auth, verification, and delivery, while eve owns session dispatch, streaming, typing, and human-in-the-loop. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for routes, streaming, and state options.`,
  },
  "chat-sdk-messenger": {
    logo: "messenger",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Chat SDK",
    keywords: ["chat sdk", "messenger", "facebook", "bot"],
    install: `Install eve, the Chat SDK core (\`chat\`), the Messenger adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat @chat-adapter/messenger @chat-adapter/state-memory
\`\`\`

The in-memory state store is fine for local development; use a durable state adapter (Redis, PostgreSQL) in production so thread subscriptions survive restarts.`,
    quickStart: `Create \`agent/channels/messenger.ts\`. Register Chat SDK handlers on \`bot\`, call \`send\` to hand each turn to eve, and export the channel:

\`\`\`ts
// agent/channels/messenger.ts
import { createMessengerAdapter } from "@chat-adapter/messenger";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: { messenger: createMessengerAdapter() },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

Credentials come from the \`createMessengerAdapter\` config or the adapter's environment variables; see the [Messenger adapter docs](https://chat-sdk.dev/adapters/official/messenger).`,
    configure: `The adapter mounts its webhook at \`/eve/v1/messenger\`. Point your Messenger webhook at it. The adapter owns provider auth, verification, and delivery, while eve owns session dispatch, streaming, typing, and human-in-the-loop. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for routes, streaming, and state options.`,
  },
  "chat-sdk-zernio": {
    logo: "zernio",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Provider official",
    keywords: [
      "chat sdk",
      "zernio",
      "instagram",
      "facebook",
      "x",
      "twitter",
      "telegram",
      "whatsapp",
      "bluesky",
      "reddit",
    ],
    install: `Install eve, Chat SDK, the Zernio adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat @zernio/chat-sdk-adapter @chat-adapter/state-memory
\`\`\`

The in-memory state store is for local development. Use Redis or PostgreSQL in production. This adapter is built and maintained by Zernio.`,
    quickStart: `Create \`agent/channels/zernio.ts\`:

\`\`\`ts
// agent/channels/zernio.ts
import { createZernioAdapter } from "@zernio/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    zernio: createZernioAdapter(),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

See the [Zernio adapter documentation](https://chat-sdk.dev/adapters/vendor-official/zernio) for supported events, capabilities, and credentials.`,
    configure: `Set \`ZERNIO_API_KEY\` and \`ZERNIO_WEBHOOK_SECRET\`, then point Zernio webhooks at \`/eve/v1/zernio\`. Zernio provides one adapter for Instagram, Facebook, X, Telegram, WhatsApp, Bluesky, and Reddit. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for eve session dispatch, state, streaming, and human-in-the-loop behavior.`,
  },
  "chat-sdk-velt": {
    logo: "velt",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Provider official",
    keywords: [
      "chat sdk",
      "velt",
      "comments",
      "collaboration",
      "documents",
      "canvas",
      "pdf",
      "video",
    ],
    install: `Install eve, Chat SDK, the Velt adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat @veltdev/chat-sdk-adapter @chat-adapter/state-memory
\`\`\`

The in-memory state store is for local development. Use Redis or PostgreSQL in production. This adapter is built and maintained by Velt.`,
    quickStart: `Create \`agent/channels/velt.ts\`:

\`\`\`ts
// agent/channels/velt.ts
import { createVeltAdapter } from "@veltdev/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    velt: createVeltAdapter({
      apiKey: process.env.VELT_API_KEY!,
      webhookSecret: process.env.VELT_WEBHOOK_SECRET!,
      botUserId: "my-agent",
      botUserName: "My Agent",
    }),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

See the [Velt adapter documentation](https://chat-sdk.dev/adapters/vendor-official/velt) for supported events, capabilities, and credentials.`,
    configure: `Create a Velt bot user and webhook, set \`VELT_API_KEY\` and \`VELT_WEBHOOK_SECRET\`, then send comment events to \`/eve/v1/velt\`. The adapter maps documents to channels, annotations to threads, and comments to messages. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for eve session dispatch, state, streaming, and human-in-the-loop behavior.`,
  },
  "chat-sdk-sendblue": {
    logo: "sendblue",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Provider official",
    keywords: ["chat sdk", "sendblue", "imessage", "sms", "rcs", "tapbacks", "phone"],
    install: `Install eve, Chat SDK, the Sendblue adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat chat-adapter-sendblue @chat-adapter/state-memory
\`\`\`

The in-memory state store is for local development. Use Redis or PostgreSQL in production. This adapter is built and maintained by Sendblue.`,
    quickStart: `Create \`agent/channels/sendblue.ts\`:

\`\`\`ts
// agent/channels/sendblue.ts
import { createSendblueAdapter } from "chat-adapter-sendblue";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    sendblue: createSendblueAdapter(),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

See the [Sendblue adapter documentation](https://chat-sdk.dev/adapters/vendor-official/sendblue) for supported events, capabilities, and credentials.`,
    configure: `Set \`SENDBLUE_API_KEY\`, \`SENDBLUE_API_SECRET\`, and \`SENDBLUE_FROM_NUMBER\`, then point Sendblue webhooks at \`/eve/v1/sendblue\`. The adapter also supports tapbacks, typing indicators, delivery callbacks, and number lookup. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for eve session dispatch, state, streaming, and human-in-the-loop behavior.`,
  },
  "chat-sdk-novu": {
    logo: "novu",
    docsHref: "/docs/channels/chat-sdk",
    badge: "Provider official",
    keywords: [
      "chat sdk",
      "novu",
      "slack",
      "teams",
      "whatsapp",
      "telegram",
      "email",
      "multichannel",
    ],
    install: `Install eve, Chat SDK, the Novu adapter, and a state adapter:

\`\`\`bash
npm install eve@latest chat @novu/chat-sdk-adapter @chat-adapter/state-memory
\`\`\`

The in-memory state store is for local development. Use Redis or PostgreSQL in production. This adapter is built and maintained by Novu.`,
    quickStart: `Create \`agent/channels/novu.ts\`:

\`\`\`ts
// agent/channels/novu.ts
import { createNovuAdapter } from "@novu/chat-sdk-adapter";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";

export const { bot, channel, send } = chatSdkChannel({
  userName: "My Agent",
  adapters: {
    novu: createNovuAdapter(),
  },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await send(message.text, { thread });
});

bot.onSubscribedMessage(async (thread, message) => {
  await send(message.text, { thread });
});

export default channel;
\`\`\`

See the [Novu adapter documentation](https://chat-sdk.dev/adapters/vendor-official/novu) for supported events, capabilities, and credentials.`,
    configure: `Run \`npx novu connect --runtime chat-sdk\` to authenticate Novu, choose a channel, and create the required environment variables. Novu manages provider credentials, identity, delivery, and conversation history across its supported channels. See the [Chat SDK channel docs](/docs/channels/chat-sdk) for eve session dispatch, state, streaming, and human-in-the-loop behavior.`,
  },
};

const extensionPresentations: Record<string, ExtensionPresentation> = {
  browserbase: {
    logo: "browserbase",
    docsHref: "https://www.npmjs.com/package/@browserbasehq/eve",
    keywords: [
      "browser",
      "browser automation",
      "cloud browser",
      "stagehand",
      "search",
      "fetch",
      "web automation",
    ],
    install: `Install the Browserbase extension for eve:

\`\`\`bash
npm install @browserbasehq/eve
\`\`\`

The extension requires Node.js 24 or later. A Browserbase API key covers both cloud browser sessions and Stagehand inference through Browserbase Model Gateway, so you do not need a separate model-provider key.`,
    quickStart: `Add your Browserbase API key to the agent's environment:

\`\`\`bash title=".env.local"
BROWSERBASE_API_KEY=bb_live_...
\`\`\`

Then mount the extension under \`agent/extensions/\`:

\`\`\`ts title="agent/extensions/browserbase.ts"
import browserbase from "@browserbasehq/eve";

export default browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY!,
});
\`\`\`

The filename supplies the \`browserbase\` namespace. The extension adds \`browserbase__search\`, \`browserbase__fetch\`, and persistent browser tools for creating sessions, navigating, observing, acting, extracting structured data, and running autonomous Stagehand tasks.`,
    configure: `Use Search → Fetch → browser as an escalation path: search for sources first, fetch straightforward content without starting a session, and create a browser only when a page requires JavaScript or interaction.

You can configure the Stagehand model, session timeout, and proxies:

\`\`\`ts title="agent/extensions/browserbase.ts"
import browserbase from "@browserbasehq/eve";

export default browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY!,
  model: "openai/gpt-5.4-mini",
  sessionTimeoutSeconds: 900,
  proxies: false,
});
\`\`\`

Browserbase uses keep-alive sessions and eve's durable per-session state to reconnect across workflow steps and function invocations. Call \`browserbase__stop_session\` when the task finishes to release billable browser time. Keep API keys out of prompts, and add approval gates around sensitive or irreversible browser actions. See the [Browserbase extension package](https://www.npmjs.com/package/@browserbasehq/eve) for the complete tool and configuration reference.`,
  },
  kernel: {
    logo: "kernel",
    docsHref: "https://www.kernel.sh/docs/integrations/vercel/eve-extension",
    keywords: [
      "browser",
      "browser automation",
      "cloud browser",
      "playwright",
      "mcp",
      "managed auth",
      "vercel connect",
    ],
    install: `Install the Kernel extension for eve:

\`\`\`bash
npm install @onkernel/eve-extension
\`\`\`

The extension requires Node.js 24 or later and eve 0.25 or later. It mounts Kernel's hosted MCP browser tools and a \`browse\` skill without requiring you to maintain browser tool code.`,
    quickStart: `Create and attach a Kernel connector with [Vercel Connect](https://vercel.com/connect):

\`\`\`bash
vercel connect create mcp.onkernel.com --name eve-extension
vercel connect attach mcp.onkernel.com/eve-extension
\`\`\`

Then mount the extension under \`agent/extensions/\`:

\`\`\`ts title="agent/extensions/kernel.ts"
import kernel from "@onkernel/eve-extension";

export default kernel({ connect: "mcp.onkernel.com/eve-extension" });
\`\`\`

The filename supplies the \`kernel\` namespace. The extension adds browser management, Playwright, computer control, managed auth, profiles, proxies, and replay tools under \`kernel__browser__*\`, along with the \`browse\` skill.`,
    configure: `For a personal or single-tenant agent, you can authenticate with a Kernel API key instead. Set \`KERNEL_API_KEY\`, then mount the extension with its default configuration:

\`\`\`ts title="agent/extensions/kernel.ts"
export { default } from "@onkernel/eve-extension";
\`\`\`

The default mount can execute JavaScript in the browser VM and reuse authenticated browser sessions. For team or multi-tenant agents, prefer Vercel Connect so each user authenticates separately, and add an approval gate by overriding the extension's \`browser\` connection. See the [Kernel eve extension guide](https://www.kernel.sh/docs/integrations/vercel/eve-extension) for API-key configuration, connection overrides, the complete tool list, and security guidance.`,
  },
  jetty: {
    logo: "jetty",
    docsHref: "https://github.com/jettyio/jetty-sdk/tree/main/packages/eve#readme",
    keywords: [
      "evals",
      "evaluation",
      "grading",
      "experiments",
      "observability",
      "trajectories",
      "bandit",
      "a/b testing",
    ],
    install: `Install the Jetty extension for eve:

\`\`\`bash
npm install @jetty/eve
\`\`\`

The extension requires Node.js 24 or later and eve 0.25 or later. It can ingest every completed turn as a durable Jetty trajectory, grade turns inline, steer experiments from their grades, and report native \`eve eval\` results.`,
    quickStart: `Add your Jetty credentials and collection to the agent's environment:

\`\`\`bash title=".env.local"
JETTY_API_TOKEN=your_token
JETTY_COLLECTION=your_collection
\`\`\`

Then mount the extension under \`agent/extensions/\`:

\`\`\`ts title="agent/extensions/jetty.ts"
import jetty from "@jetty/eve";

export default jetty({
  collection: process.env.JETTY_COLLECTION ?? "",
  task: "triage-live",
  judgeMode: "simple_judge",
  arms: {
    warm: "Write a warm, specific response.",
    terse: "Write a concise, direct response.",
  },
});
\`\`\`

The filename supplies the \`jetty\` namespace. The extension contributes a turn-ingestion hook, dynamic instructions that select an experiment arm, and \`jetty__experiment\`, which reports per-arm results and the current leader. Create the \`simple_judge\` task in Jetty before using inline grading; use the default \`ingest\` mode when a separate grader will score trajectories later.`,
    configure: `The package also includes a reporter for eve's native eval runner:

\`\`\`ts title="evals/evals.config.ts"
import { Jetty } from "@jetty/eve/reporter";
import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  reporters: [Jetty()],
});
\`\`\`

The reporter reads \`JETTY_API_TOKEN\` and \`JETTY_COLLECTION\`, sends each eval result to Jetty, and warns rather than failing the eval when Jetty is unavailable. The extension no-ops when its collection is empty, so the same agent can run without Jetty credentials.

Jetty trajectories persist agent inputs and outputs. Redact PII before grading, put sensitive grader parameters in Jetty's \`secretParams\` rather than \`initParams\`, and treat trajectory storage like any other logging surface. See the [Jetty eve extension documentation](https://github.com/jettyio/jetty-sdk/tree/main/packages/eve#readme) for all experiment settings and the [worked example](https://github.com/jettyio/jetty-sdk/tree/main/examples/eve-jetty) for the complete grading loop.`,
  },
  "github-tools": {
    logo: "github",
    docsHref: "https://github-tools.com/frameworks/eve#eve-extension",
    keywords: [
      "github",
      "repositories",
      "pull requests",
      "issues",
      "code review",
      "ci",
      "vercel connect",
      "approval",
    ],
    install: `Install the GitHub Tools extension and Vercel Connect client:

\`\`\`bash
npm install @github-tools/eve-extension @vercel/connect
\`\`\`

The extension provides the GitHub toolset as a versioned eve package. Use a Vercel Connect connector for short-lived, scoped GitHub tokens, or omit \`@vercel/connect\` and authenticate with a GitHub token.`,
    quickStart: `Create and attach a GitHub connector to the Vercel project that runs your agent:

\`\`\`bash
vercel link
vercel connect create github --name my-connector
vercel connect attach github/my-connector --yes
vercel env pull
\`\`\`

Then mount the extension under \`agent/extensions/\`:

\`\`\`ts title="agent/extensions/github.ts"
import githubExtension from "@github-tools/eve-extension";

export default githubExtension({
  connector: "github/my-connector",
  preset: "maintainer",
  requireApproval: {
    mergePullRequest: true,
  },
});
\`\`\`

The filename supplies the \`github\` namespace, so tools appear as \`github__listPullRequests\`, \`github__createIssue\`, and \`github__addPullRequestComment\`. The preset automatically limits the connector token to the scopes its tools need.`,
    configure: `Choose one or more presets to limit the available tools: \`code-review\`, \`issue-triage\`, \`repo-explorer\`, \`ci-ops\`, or \`maintainer\`. Every write tool requires approval by default, while read tools do not. Use \`requireApproval\` to apply \`always\`, \`once\`, or an input-dependent policy to individual tools:

\`\`\`ts title="agent/extensions/github.ts"
import githubExtension from "@github-tools/eve-extension";

export default githubExtension({
  connector: "github/my-connector",
  preset: ["code-review", "issue-triage"],
  requireApproval: {
    addPullRequestComment: "once",
    mergePullRequest: true,
    createIssue: ({ toolInput }) => toolInput?.owner !== "my-org",
  },
});
\`\`\`

For local or non-Vercel deployments, omit \`connector\` and set \`GITHUB_TOKEN\`; the extension also accepts an explicit \`token\`. Prefer fine-grained credentials, expose only the presets the agent needs, and keep approval enabled for writes. See the [GitHub Tools eve documentation](https://github-tools.com/frameworks/eve#eve-extension) for token authentication, per-tool overrides, commit attribution, and the complete tool catalog.`,
  },
  "agent-browser": {
    logo: "agent-browser",
    docsHref:
      "https://github.com/vercel-labs/agent-browser/tree/main/packages/%40agent-browser/eve",
    keywords: [
      "browser",
      "browser automation",
      "web automation",
      "cli",
      "chrome",
      "playwright",
      "puppeteer",
      "kernel",
      "browserbase",
      "browser use",
    ],
    install: `Install the agent-browser extension for eve:

\`\`\`bash
npm install @agent-browser/eve
\`\`\`

The extension installs agent-browser automatically on first use and runs it inside the agent's sandbox. It requires a sandbox backend with real process execution, such as Vercel Sandbox, Docker, or microsandbox.`,
    quickStart: `Mount the extension under \`agent/extensions/\`:

\`\`\`ts title="agent/extensions/browser.ts"
import browser from "@agent-browser/eve";

export default browser({});
\`\`\`

The filename supplies the \`browser\` namespace. The extension adds tools such as \`browser__navigate\`, \`browser__snapshot\`, \`browser__click\`, \`browser__fill\`, \`browser__find\`, and \`browser__screenshot\`. agent-browser keeps the underlying browser process and session state in the eve sandbox.`,
    configure: `Restrict browser access to the sites the agent needs with the extension's domain allow-list:

\`\`\`ts title="agent/extensions/browser.ts"
import browser from "@agent-browser/eve";

export default browser({
  allowedDomains: ["example.com", "*.example.com"],
  contentBoundaries: true,
  maxOutputChars: 50_000,
});
\`\`\`

Also configure the [sandbox network policy](/docs/sandbox#network-policy) for defense in depth. Treat saved browser state, cookies, screenshots, downloads, and recordings as sensitive data. Do not place passwords or session tokens in prompts. Use the extension's per-tool overrides to gate or disable actions your agent should not take unattended.

The extension also supports inline screenshots, session naming, proxies, and production pre-installation. See the [agent-browser eve extension documentation](https://github.com/vercel-labs/agent-browser/tree/main/packages/%40agent-browser/eve) for the complete options and example app.`,
  },
};

/**
 * Connection presentation overlay, keyed by catalog slug. Transport (`mcp`,
 * `openapi`) and the model-facing description come from `@vercel/eve-catalog`;
 * this carries the docs-only auth modes, optional connector UID, and configure
 * note.
 */
const connectionPresentations: Record<string, ConnectionPresentation> = {
  "browser-use": {
    logo: "browser-use",
    docsHref: "https://docs.browser-use.com/cloud/guides/mcp-server",
    keywords: ["mcp", "browser", "browser automation", "cloud browser", "web automation"],
    authModes: ["apiKey"],
    apiKey: {
      env: "BROWSER_USE_API_KEY",
      header: "x-browser-use-api-key",
    },
    configureNote:
      "Browser Use runs tasks in managed cloud browsers. Add approval gates or tool filters before allowing unattended browser actions.",
  },
  vercel: {
    logo: "vercel",
    docsHref: "https://vercel.com/docs/agent-resources/vercel-mcp",
    keywords: ["mcp", "projects", "deployments", "logs", "oauth", "connect"],
    authModes: ["user"],
    connector: "vercel",
    connectorService: "vercel",
    configureNote:
      "When the Connect form asks for a token authentication method, select None. Vercel MCP completes OAuth when the agent first calls an authenticated tool.",
  },
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
    badge: presentation.badge,
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
  if (presentation.apiKey !== undefined) spec.apiKey = presentation.apiKey;
  if (presentation.connector !== undefined) spec.connector = presentation.connector;
  if (presentation.connectorService !== undefined) {
    spec.connectorService = presentation.connectorService;
  }
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

function buildExtension(entry: IntegrationEntry): Integration {
  const presentation = extensionPresentations[entry.slug];
  if (presentation === undefined) {
    throw new Error(
      `Extension "${entry.slug}" is in the catalog gallery but has no docs presentation.`,
    );
  }
  return {
    slug: entry.slug,
    name: entry.name,
    type: "extension",
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

const extensions: Integration[] = extensionEntries()
  .filter((entry) => entry.surfaces.gallery)
  .map(buildExtension);

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
};

export const integrations: Integration[] = [...channels, ...extensions, ...connections];

export const getIntegration = (slug: string): Integration | undefined =>
  integrations.find((integration) => integration.slug === slug);

export const integrationSlugs = (): string[] => integrations.map((integration) => integration.slug);
