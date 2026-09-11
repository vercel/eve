# Environment Variables

> Back to [README](../README.md) | See also: [Architecture](./ARCHITECTURE.md), [Customization](./CUSTOMIZATION.md)

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

## Quick start (minimum required)

| Variable              | How to get it                                                    |
| --------------------- | ---------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`  | Run `openssl rand -base64 32`                                    |
| `BETTER_AUTH_URL`     | `http://localhost:3000` locally, or your production URL          |
| `INTERNAL_API_SECRET` | Run `openssl rand -base64 32` (must match on web + eve services) |

These three variables are enough for local development. On Vercel, set them on **both** the `web` and `eve` services — and add a database (see below).

## Database

### `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (required on Vercel)

Locally, NuxtHub (`hub.db: "sqlite"`) uses a SQLite file at `.data/db/sqlite.db`, so no configuration is needed. On Vercel (or any serverless host) that local file cannot be created — without a hosted database every request fails with:

```
Error: ConnectionFailed("Unable to open connection to local database .../.data/db/sqlite.db: 14")
```

Provision a [Turso database from the Vercel Marketplace](https://vercel.com/marketplace/tursocloud) — the Deploy button in the README includes it automatically, or add it to an existing project:

```bash
vercel integration add turso
```

This sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` on the project. NuxtHub detects them at **build time** and switches from the local file to the remote libSQL database, so redeploy after adding them. Then apply the schema:

```bash
vercel env pull .env --yes
pnpm db:migrate
```

### `NUXT_PUBLIC_SITE_URL` (optional)

Canonical URL for SEO — used for Open Graph images, Twitter cards, and canonical links. Set to your production URL (e.g. `https://your-app.vercel.app`). Falls back to the request origin when unset.

## Authentication

### `BETTER_AUTH_SECRET` (required)

Random secret used by [Better Auth](https://www.better-auth.com/docs/installation#set-environment-variables) to sign sessions and tokens.

```bash
openssl rand -base64 32
```

### `BETTER_AUTH_URL` (required)

Public URL of the Nuxt app. Used for auth callbacks and as the base URL for agent → Nuxt internal API calls.

| Environment | Value                            |
| ----------- | -------------------------------- |
| Local       | `http://localhost:3000`          |
| Production  | `https://your-domain.vercel.app` |

## Internal API

### `INTERNAL_API_SECRET` (required)

Shared bearer token between the Eve agent service and the Nuxt internal API (`/api/internal/*`).

Used for:

- Memory read/write from the agent
- Slack account linking
- Sendblue / iMessage phone linking lookup

**Must be identical** on both Vercel services (`web` and `eve`). If missing or mismatched, memory injection, Slack linking, and iMessage auth will fail silently or return 401.

## Sendblue (iMessage, optional)

Reach the agent over iMessage via [Sendblue](https://chat-sdk.dev/adapters/vendor-official/sendblue). Set these on the **eve** service (and `BETTER_AUTH_URL` on both services so the agent can resolve phone links):

| Variable                       | Required    | Description                                                                             |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------- |
| `SENDBLUE_API_KEY`             | Yes         | API key ID from the [Sendblue dashboard](https://dashboard.sendblue.com)                |
| `SENDBLUE_API_SECRET`          | Yes         | API secret key                                                                          |
| `SENDBLUE_FROM_NUMBER`         | Yes         | Your Sendblue line in E.164 format (e.g. `+15551234567`)                                |
| `SENDBLUE_WEBHOOK_SECRET`      | Recommended | Shared secret verified via the `sb-signing-secret` header                               |
| `SENDBLUE_STATUS_CALLBACK_URL` | No          | Delivery status callbacks for outbound messages                                         |
| `SENDBLUE_ALLOWED_SERVICES`    | No          | Comma-separated list; defaults to `iMessage` only. Use `iMessage,SMS,RCS` to accept all |

Setup:

1. Create a Sendblue account and note your API credentials and assigned number (`sendblue show-keys`, `sendblue lines`).
2. Set the env vars above on the **eve** Vercel service.
3. Configure the Sendblue **receive webhook** to:

   `https://<your-domain>/_eve_internal/eve/eve/v1/sendblue/webhook`

4. Users add their personal phone number (E.164) in **Settings → Profile** before messaging the Sendblue number.

See [Customization](./CUSTOMIZATION.md#sendblue-imessage) for the full linking flow.

## AI provider

This template does not define AI keys in `.env.example`. The default model is set in [`agent/agent.ts`](../agent/agent.ts):

```typescript
model: "anthropic/claude-sonnet-4.6";
```

On Vercel, Eve handles provider configuration through the platform. For local development, follow [Eve docs](https://eve.dev) for your chosen provider.

## Vercel Connect (optional)

Integrations use [Vercel Connect](https://vercel.com/docs/connect) — no extra env vars in this repo for Linear or GitHub OAuth, but you must:

1. Create Connect resources (GitHub, Linear MCP, Slack) in your Vercel team
2. Update connector UIDs in [`shared/connect.ts`](../shared/connect.ts) (GitHub) or [`agent/channels/slack.ts`](../agent/channels/slack.ts) (Slack, default: `slack/v`)
3. Connect clients in **Settings → Integrations** in the app

See [Customization](./CUSTOMIZATION.md#integrations) for setup steps.

## GitHub (optional)

GitHub tools use per-user OAuth via Vercel Connect. Connect in **Settings → Integrations**, then start a new chat session so GitHub tools load at `session.started`.

## Local-only files

These paths are gitignored and should never be committed:

| Path       | Purpose                   |
| ---------- | ------------------------- |
| `.env`     | Local secrets             |
| `.data/`   | SQLite database (NuxtHub) |
| `.eve/`    | Eve dev cache             |
| `.vercel/` | Vercel CLI link metadata  |

Reset the local database:

```bash
rm -rf .data/db && pnpm db:migrate
```
