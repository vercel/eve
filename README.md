<div align="center">
  <a href="https://github.com/vercel/eve">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/eve.svg">
      <img alt="Eve logo" src=".github/assets/eve.svg" height="128">
    </picture>
  </a>
  <h1>Eve</h1>

<a href="https://vercel.com"><img alt="Vercel logo" src="https://img.shields.io/badge/MADE%20BY%20Vercel-000000.svg?style=for-the-badge&logo=Vercel&labelColor=000"></a>
<a href="https://www.npmjs.com/package/eve"><img alt="NPM version" src="https://img.shields.io/npm/v/eve.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/vercel/eve/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/eve.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/vercel/eve/discussions"><img alt="Join the community on GitHub" src="https://img.shields.io/badge/Join%20the%20community-blueviolet.svg?style=for-the-badge&logo=Github&labelColor=000000&logoWidth=20"></a>

</div>

## Getting Started

Eve is a filesystem-first framework for durable backend agents on Vercel.

You author an agent as a directory on disk. The directory is the contract:

- `instructions.md` defines the always-on instructions prompt
- `skills/` define optional procedures
- `tools/` define typed executable integrations
- `connections/` define external MCP server connections
- `sandbox/` overrides the agent's single sandbox (optional) and seeds workspace files
- `channels/` define message ingress and delivery
- `subagents/` define specialist child agents
- `schedules/` define recurring jobs
- `lib/` holds shared authored code
- `agent.ts` holds additive runtime config such as model, metadata, build, compaction, and workspace settings

The framework package is `eve`. The CLI binary is `eve`.

## What Eve Prioritizes

- Markdown-first authoring for instructions and procedures
- TypeScript where typed runtime behavior matters
- Durable message runs and follow-up turns
- Inspectable compiled artifacts under `.eve/`
- Per-agent sandbox with optional authored overrides
- A stable HTTP protocol with explicit `continuationToken` and `sessionId` contracts
- A runtime model that keeps channels, harnesses, and workflow execution separate

## Current Mental Model

Eve’s internal split is:

- the channel normalizes inbound transport, applies auth and delivery policy, and owns `continuationToken`
- the harness does one unit of AI work and returns `{ session, next }`
- the runtime persists state, follows `next`, streams events, and owns workflow primitives

That split is why the public HTTP protocol separates:

- `continuationToken` for the next user message
- `sessionId` for streaming and inspection

## Example Layout

```text
my-agent/
├── package.json
├── tsconfig.json
└── agent/
    ├── agent.ts
    ├── instructions.md
    ├── skills/
    ├── tools/
    ├── connections/
    ├── sandbox/
    ├── channels/
    ├── subagents/
    ├── schedules/
    └── lib/
```

## Tiny Example

`agent/instructions.md`

```md
You are a weather-focused assistant. Be concise, accurate, and explicit when you use a tool.
```

`agent/tools/get_weather.ts`

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string(),
  }),
  async execute(input) {
    return {
      city: input.city,
      condition: "Sunny",
      temperatureF: 72,
    };
  },
});
```

`agent/agent.ts`

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.4-mini",
  name: "weather-agent",
});
```

## Quick Start

```bash
npx eve@latest init my-agent
```

The command creates the project, installs its dependencies, initializes Git,
and starts the development server. Add `--channel-web-nextjs` to scaffold the Web Chat
application. If you already created an empty directory, run `eve init`,
`eve init .`, or `eve init ./` from inside it to run the same full scaffold there,
including `package.json`. In a non-empty existing app, `eve init .` adds the
agent files and missing dependencies instead; that add-agent flow requires an
existing `package.json`. `eve init` does not create or link a Vercel project.

Useful commands:

- `eve info` shows discovery results and compiled artifacts
- `eve init [name]` creates a new agent
- `eve build` compiles `.eve/` and builds the host output
- `eve start` serves the built `.output/` app
- `eve dev` starts the local runtime and interactive terminal UI

## Public Docs

Start here:

1. [`docs/README.md`](docs/README.md)
2. [`docs/getting-started.mdx`](docs/getting-started.mdx)
3. [`docs/reference/project-layout.md`](docs/reference/project-layout.md)
4. [`docs/agent-config.md`](docs/agent-config.md)
5. [`docs/reference/typescript-api.md`](docs/reference/typescript-api.md)
6. [`docs/connections.mdx`](docs/connections.mdx)

## Repo Guide

- [`packages/eve/README.md`](packages/eve/README.md) is the package-facing overview
- [`apps/fixtures/weather-agent`](apps/fixtures/weather-agent) is the weather-focused fixture used by local dev, smokes, and bundle analysis
- [`packages/eve/src/public/index.ts`](packages/eve/src/public/index.ts) is the public API source of truth
