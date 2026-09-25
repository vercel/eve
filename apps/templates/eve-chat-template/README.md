# eve Chat Template

A Next.js chat template for [eve](https://eve.dev) that starts with password access and browser-persisted chats, then upgrades to durable memory, Sign in with Vercel, Neon, and Upstash when you need a production multi-user application.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-description=A%20persisted%20Next.js%20chat%20template%20for%20eve%2C%20built%20with%20shadcn%2Fui%2C%20Tailwind%20CSS%2C%20Streamdown%2C%20Better%20Auth%2C%20Drizzle%2C%20and%20Neon.&demo-image=https%3A%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2FYXYTquqpBmvVFbASdIvrC%2Fbb50d21ba7866882d90e25d842b6fc02%2Feve-chat-no-bg.png&demo-title=eve%20Chat%20Template&demo-url=https%3A%2F%2Fchat.eve.dev&env=EVE_CHAT_PASSWORD&envDescription=Choose%20a%20strong%20password%20to%20protect%20your%20agent%20%2816%2B%20characters%20recommended%29.&envLink=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Fblob%2Fmain%2Fapps%2Ftemplates%2Feve-chat-template%2Fdocs%2Fsetup-and-deploy.md&from=templates&project-name=eve%20Chat%20Template&repository-name=eve-chat-template&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-chat-template)

## Quick Start

Deploy the starter without provisioning a database or other Marketplace products:

1. Click **Deploy with Vercel**.
2. Enter a strong `EVE_CHAT_PASSWORD` (16+ characters recommended).
3. Open the deployed app and enter that password.

Chats and eve session cursors are stored in that browser. They are not shared across browsers or users. The starter does not enable cross-session long-term memory on Vercel until you set up Blob storage; see [Long-Term Memory](docs/setup-and-deploy.md#long-term-memory).

Starter mode is intended for one trusted operator: anyone with the password
shares the same agent identity and connection grants.

## Deployment Modes

| Mode              | Selected when                                                       | Authentication                            | Chat persistence     | Long-term memory                        |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------- | -------------------- | --------------------------------------- |
| Starter           | `EVE_CHAT_PASSWORD` is configured                                   | Shared password and secure session cookie | Browser localStorage | Shared Vercel Blob document after setup |
| Production        | Neon, Upstash, and all Sign in with Vercel variables are configured | Sign in with Vercel                       | Neon                 | Per-user Vercel Blob document           |
| Local development | Neither mode is configured and `next dev` is running locally        | Local development identity                | Browser localStorage | Process-local                           |

Production mode takes precedence when its complete environment is present. The app fails closed in a production deployment when neither mode is configured. See [Setup and Deployment](docs/setup-and-deploy.md) for the upgrade path.

## Getting Started

For the starter and production setup flows, see [Setup and Deployment](docs/setup-and-deploy.md). For the runtime architecture, streaming model, persistence flow, and extension points, see [How the Chatbot Works](docs/how-the-chatbot-works.md).

Install dependencies with pnpm:

```bash
pnpm install
```

Run locally without additional services:

```bash
pnpm dev
```

To require the same password locally, put this in `.env.local`:

```bash
EVE_CHAT_PASSWORD=<at-least-16-characters>
```

To upgrade the linked project to production mode, run the setup script. It provisions private Vercel Blob storage for memory, Neon, and Upstash; registers Sign in with Vercel; pulls environment variables; and runs migrations. Blob usage may incur charges:

```bash
./scripts/setup.sh
# Or: ./scripts/setup.sh --scope <team-slug>
```

Production mode requires:

```bash
DATABASE_URL=
BETTER_AUTH_SECRET=
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=
VERCEL_APP_CLIENT_SECRET=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

Other optional environment variables:

```bash
# Override the app origin for custom production domains.
BETTER_AUTH_URL=

# Enable hosted Vercel Connect integrations.
SLACK_CONNECTOR=
LINEAR_CONNECTOR=
NOTION_CONNECTOR=
SENTRY_CONNECTOR=
```

Create optional Vercel Connect integrations:

```bash
# Slack channel
vercel connect create slack --name eve-chat-template --triggers
vercel connect attach <slack-connector-uid> --triggers --trigger-path /eve/v1/slack --yes

# MCP connections
vercel connect create mcp.notion.com --name notion
vercel connect create https://mcp.linear.app/mcp --name linear
vercel connect create https://mcp.sentry.dev/mcp --name sentry
```

The deploy button does not require these integrations. For manual setup, put the returned connector UIDs in `SLACK_CONNECTOR`, `NOTION_CONNECTOR`, `LINEAR_CONNECTOR`, and `SENTRY_CONNECTOR`. Local development falls back to `slack/eve-chat-template`, `notion`, `linear`, and `sentry`, so connectors created with the names above work without editing `agent/`.

The composer only shows its connections menu when at least one MCP connector is configured. Password-only starter deployments therefore omit the menu and do not prompt eve to use unavailable connections.

If the connector is not attached to the linked project, run:

```bash
vercel connect attach <connector-uid> --yes
vercel env pull .env.local
```

Production mode only: create the database tables:

```bash
pnpm db:migrate
```

For production, run migrations with Vercel production env vars:

```bash
vercel env run -e production -- pnpm db:migrate
```

Start the development server:

```bash
pnpm dev
```

## What Is Included

- Text chat with an eve agent through same-origin `/eve/v1/*` routes
- Password access with browser-backed chat history by default
- Optional Better Auth sign-in with Vercel
- Optional Neon-backed cross-device chat history
- Optional Upstash Redis rate limiting in production mode
- Optional long-term memory in a private Vercel Blob document (per user in production mode)
- Drizzle schema and migrations for production mode under `lib/db`
- Saved eve session cursors and event snapshots in either storage mode
- Sidebar history with delete and new-chat actions
- Vercel Connect-backed Notion, Linear, and Sentry MCP connections
- Vercel Connect-backed Slack channel route at `/eve/v1/slack`
- Composer-level connections menu
- First-message chat titles derived locally from the user's prompt
- Streamdown markdown rendering for assistant text and reasoning
- shadcn/Tailwind components for messages, tools, HITL prompts, and composer

This template intentionally does not include file uploads, guest mode, NextAuth/Auth.js, or AI Elements.

## Agent Code

Edit the agent in `agent/agent.ts`. Its behavior is defined in `agent/instructions.md`, tools live in `agent/tools/`, and `agent/memory/profile.ts` defines per-user long-term memory.

The browser talks to eve with `useEveAgent()` from `eve/react`; the app stores eve stream events and session state so `/chat/[id]` can resume the same durable conversation after refresh.
