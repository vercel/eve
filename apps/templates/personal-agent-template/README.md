<img src="./public/banner.png" width="100%" alt="Personal Agent Template" />

# Personal Agent Template

[![CI](https://img.shields.io/github/actions/workflow/status/vercel-labs/personal-agent-template/ci.yml?branch=main&color=black)](https://github.com/vercel-labs/personal-agent-template/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/vercel-labs/personal-agent-template?color=black)](https://github.com/vercel-labs/personal-agent-template/blob/main/LICENSE)
[![Vercel](https://img.shields.io/badge/Vercel-black?logo=vercel&logoColor=white)](https://vercel.com)

**Template.** Fork it, customize it, and deploy your own personal agent.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Fpersonal-agent-template&env=BETTER_AUTH_SECRET,BETTER_AUTH_URL,INTERNAL_API_SECRET&envDescription=BETTER_AUTH_SECRET%3A%20run%20openssl%20rand%20-base64%2032%20%7C%20BETTER_AUTH_URL%3A%20your%20production%20URL%20%7C%20INTERNAL_API_SECRET%3A%20shared%20secret%20for%20web%20%2B%20eve&envLink=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Fblob%2Fmain%2Fapps%2Ftemplates%2Fpersonal-agent-template%2Fdocs%2FENVIRONMENT.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22tursocloud%22%2C%22productSlug%22%3A%22database%22%2C%22protocol%22%3A%22storage%22%7D%5D&project-name=personal-agent&repository-name=personal-agent)

Open source personal agent template. Web chat, Slack, iMessage, GitHub, Linear, and long-term memory — one codebase, durable sessions, user-approved memory saves.

## Features

### Web Chat — Threads That Persist

Chat with your agent in the browser. Threads resume across sessions, tool calls render in real time, and `save_memory` proposals require explicit approval before anything is stored.

### Slack — Same Agent, Different Surface

DMs and @mentions on Slack. Link your Slack account to your web profile so memory and context follow you across channels.

### iMessage — Text Your Agent

Reach V over iMessage via [Sendblue](https://chat-sdk.dev/adapters/vendor-official/sendblue). Add your phone number in **Profile**, then message the Sendblue line — same memory and context as web and Slack.

### GitHub — Repos, PRs, and CI

Connect GitHub via Vercel Connect. Ask about repositories, pull requests, issues, and workflows — the agent uses [@github-tools/sdk](https://github-tools.com/frameworks/eve) tools with durable approval on writes.

### Linear — Issues On Demand

Connect Linear via Vercel Connect MCP. Ask about issues, projects, and cycles — the agent queries Linear tools, never guesses from memory.

### Long-Term Memory — Import and Grow

Raycast-style import from ChatGPT or other assistants. Five fixed categories, one prose block each. Edit, delete, or let the agent propose updates via `save_memory`.

### Daily Summary — On Demand

Morning briefing skill: active focus from memory, assigned Linear issues, and a suggested next action. Trigger from the home quick action or ask in chat.

## [Architecture](./docs/ARCHITECTURE.md)

```
┌─────────────────────────────────────────────────────────────────┐
│              Web chat · Slack DMs / mentions · iMessage           │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│              Eve agent (channels, tools, skills)                 │
└───────────────────────────────┬─────────────────────────────────┘
                                │ /api/internal/* (Bearer auth)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│         Nuxt (UI + Nitro API + Better Auth + SQLite)           │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
                      Vercel Connect (Linear, Slack)
```

On Vercel, two services deploy from [`vercel.json`](vercel.json): `web` (Nuxt) and `eve` (agent runtime).

## Quick Start

### Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Fpersonal-agent-template&env=BETTER_AUTH_SECRET,BETTER_AUTH_URL,INTERNAL_API_SECRET&envDescription=BETTER_AUTH_SECRET%3A%20run%20openssl%20rand%20-base64%2032%20%7C%20BETTER_AUTH_URL%3A%20your%20production%20URL%20%7C%20INTERNAL_API_SECRET%3A%20shared%20secret%20for%20web%20%2B%20eve&envLink=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Fblob%2Fmain%2Fapps%2Ftemplates%2Fpersonal-agent-template%2Fdocs%2FENVIRONMENT.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22tursocloud%22%2C%22productSlug%22%3A%22database%22%2C%22protocol%22%3A%22storage%22%7D%5D&project-name=personal-agent&repository-name=personal-agent)

### Self-hosting

**Requirements:** Node.js 24+, pnpm

```bash
git clone https://github.com/vercel-labs/personal-agent-template.git
cd personal-agent-template

pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, and start chatting.

**Required environment variables:**

```bash
BETTER_AUTH_SECRET=...       # openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:3000
INTERNAL_API_SECRET=...      # openssl rand -base64 32 — same on web + eve
```

See [ENVIRONMENT.md](./docs/ENVIRONMENT.md) for the full reference.

Fresh local database:

```bash
rm -rf .data/db && pnpm db:migrate
```

## Customization

Personal Agent Template ships with **V** as the example persona. See the [Customization Guide](./docs/CUSTOMIZATION.md) for how to:

- Rename your agent (name, slug, persona)
- Change the AI model
- Add tools and skills
- Configure Slack, iMessage, and Linear integrations
- Theme the UI
- Deploy your fork

## Memory

Long-term memory is injected into every Eve session for authenticated users (web, linked Slack, and iMessage).

1. Open **Profile → Import Memory**
2. Copy the export prompt into ChatGPT, Claude, etc.
3. Paste the response → **Add to Memory**
4. Start a **new chat** so the agent picks up the latest context

V can also propose facts via **`save_memory`** — approve or skip in chat. Edit or delete entries on **Profile → Memory**.

## How It Works

> For the full technical deep-dive, see [Architecture](./docs/ARCHITECTURE.md).

1. **Auth**: Users sign in via Better Auth (email/password)
2. **Session start**: Eve fetches profile + memory and injects into agent instructions
3. **Chat**: Web UI streams through Eve; Slack events hit the slack channel; iMessage via Sendblue
4. **Tools**: Agent calls weather, save_memory, Linear MCP as needed
5. **Internal API**: Agent reads/writes memory, Slack links, and phone links via authenticated Nitro routes

## Development

```bash
pnpm dev          # Nuxt + Eve (eve/nuxt module — see Eve docs)
pnpm typecheck    # TypeScript check
pnpm build        # Production build
pnpm db:generate  # Generate Drizzle migrations
pnpm db:migrate   # Apply migrations
```

See [AGENTS.md](./AGENTS.md) for notes aimed at AI coding assistants.

## Built With

- [Eve](https://eve.dev) — Durable agent framework
- [Nuxt](https://nuxt.com) — Full-stack Vue framework
- [Nuxt UI](https://ui.nuxt.com) — UI component library
- [NuxtHub](https://hub.nuxt.com) — SQLite database
- [Better Auth](https://www.better-auth.com) — Authentication
- [Drizzle ORM](https://orm.drizzle.team) — Type-safe database queries
- [Vercel Connect](https://vercel.com/docs/connect) — Linear and Slack integrations

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved.

## License

[MIT](./LICENSE)
