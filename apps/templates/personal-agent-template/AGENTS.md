# Personal Agent Template

Durable personal AI assistant built with Eve and Nuxt.

## Quick Reference

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `pnpm install`      | Install dependencies                 |
| `pnpm dev`          | Start the Nuxt web app               |
| `pnpm dev:services` | Start the local Vercel service graph |
| `pnpm build`        | Production build                     |
| `pnpm typecheck`    | TypeScript check                     |
| `pnpm db:generate`  | Generate Drizzle migrations          |
| `pnpm db:migrate`   | Apply migrations                     |

## Structure

```
personal-agent-template/
├── agent/          # Eve agent (channels, tools, skills, connections)
├── apps/web/       # Nuxt UI, Nitro API, and shared application code
└── docs/           # Architecture, environment, customization
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — System design, request flows, internal API
- [Environment](docs/ENVIRONMENT.md) — Environment variables
- [Customization](docs/CUSTOMIZATION.md) — Rename agent, add tools, integrations
- [README](README.md) — Quick start and feature overview

## Eve Framework

This project deploys its Nuxt frontend and eve agent as peer Vercel services through `vercel.ts`. Before writing agent code, read the relevant guide in `node_modules/eve/dist/docs/public/`.

## Internal API Pattern

The Eve agent calls Nuxt over HTTP:

```
agent/lib/*-internal.ts  →  /api/internal/*  →  server/utils/*
```

Authenticated with `Authorization: Bearer <INTERNAL_API_SECRET>`. See [`apps/web/server/utils/internal-api.ts`](apps/web/server/utils/internal-api.ts).

## Memory Flow

1. **Session injection** — [`agent/instructions.ts`](agent/instructions.ts) on `session.started`
2. **Agent save** — [`agent/tools/save_memory.ts`](agent/tools/save_memory.ts) with web approval UI
3. **Profile UI** — import, view, edit, delete on Settings → Profile

Categories: [`lib/types/memory.ts`](lib/types/memory.ts). One prose block per category; saves replace the full block.

## Customization Checklist

- [`lib/agent.ts`](lib/agent.ts) — branding
- [`agent/lib/base-instructions.ts`](agent/lib/base-instructions.ts) — persona
- [`agent/channels/slack.ts`](agent/channels/slack.ts) — Slack Connect slug
- [`agent/agent.ts`](agent/agent.ts) — AI model

See [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) for details.
