# eve

eve is a filesystem-first framework for durable backend agents on Vercel.

You author an agent as a directory on disk. The directory is the contract — markdown for the parts a human should read like a spec, TypeScript for the parts that benefit from real types and runtime behavior.

The framework is called eve. The published npm package is `eve`. The CLI binary is `eve`.

## Preview Terms and Safeguards

eve is currently a preview and subject to the Vercel beta terms; the framework, APIs, documentation, and behavior may change before general availability.

As the deployer, it is your responsibility to ensure your agent complies with applicable laws.

You are responsible for configuring approval policies, tool restrictions, connection scopes, route/session authorization, sandbox controls, telemetry exports, and other safeguards appropriate for your use case.

Before using eve with non-public, sensitive, regulated, or production data, review which default tools, custom tools, MCP tools, shell/file/web tools, connected services, subagents, schedules, and external actions are available to the agent.

Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

Unless you configure stricter controls, eve agents may operate with permissive settings, including tool execution without human approval where approval is omitted and sandbox network egress that is not deny-all. Do not rely on model behavior alone to prevent sensitive or irreversible actions.

## What eve Prioritizes

- Markdown-first authoring for instructions and procedures
- TypeScript where typed runtime behavior matters
- Durable message runs and follow-up turns
- Inspectable compiled artifacts under `.eve/`
- Per-agent sandbox with optional authored overrides
- A stable HTTP protocol with explicit `continuationToken` and `sessionId` contracts
- A runtime model that keeps channels, harnesses, and workflow execution separate

## Authored Directory

```text
my-agent/
├── package.json
├── tsconfig.json
└── agent/
    ├── agent.ts           # additive runtime config (model, name, build, compaction, …)
    ├── instructions.md    # always-on instructions prompt
    ├── tools/             # typed executable integrations
    ├── skills/            # optional named procedures the model can load on demand
    ├── hooks/             # lifecycle and stream-event subscribers
    ├── channels/          # message ingress and delivery (HTTP, Slack, …)
    ├── connections/       # external MCP server connections
    ├── sandbox/           # the agent's single sandbox (optional override)
    ├── workspace/         # files seeded into the sandbox on each session
    ├── subagents/         # specialist child agents (reuse `defineAgent`)
    ├── schedules/         # recurring jobs
    └── lib/               # shared authored code imported by other files
```

## Authoring Helpers

Every authored directory has a typed helper. Import each from the matching subpath:

| Helper                                                                                                              | Subpath                               | Authored Location                                |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `defineAgent(...)`                                                                                                  | `eve`                                 | `agent.ts`, `subagents/<id>/agent.ts`            |
| `defineInstructions(...)`                                                                                           | `eve/instructions`                    | `instructions.ts` (or `instructions.md`)         |
| `defineTool(...)`, `defineBashTool(...)`, `defineReadFileTool(...)`, `defineWriteFileTool(...)`, `disableTool(...)` | `eve/tools`                           | `tools/<name>.ts`                                |
| `defineSkill(...)`, `getSkill(...)`                                                                                 | `eve/skills`                          | `skills/<name>.ts` (or `skills/<name>.md`)       |
| `defineHook(...)`                                                                                                   | `eve/hooks`                           | `hooks/<slug>.ts`                                |
| `defineChannel(...)`, `POST`, `GET`                                                                                 | `eve/channels`                        | `channels/<name>.ts`                             |
| `eveChannel(...)`, `slackChannel(...)`, `vercelOidc(...)`                                                           | `eve/channels/eve`, `/slack`, `/auth` | reused from `channels/<name>.ts`                 |
| `defineSandbox(...)`                                                                                                | `eve/sandbox`                         | `sandbox.ts` (or `sandbox/sandbox.ts`)           |
| `defineSchedule(...)`                                                                                               | `eve/schedules`                       | `schedules/<name>.ts` (or `schedules/<name>.md`) |
| `defineEval(...)`, `defineEvalConfig(...)`                                                                          | `eve/evals`                           | `evals/<name>.eval.ts`, `evals/evals.config.ts`  |

Runtime accessors live on the subpath that owns the concern:

- `getSession()` — current session, turn, auth, parent lineage (`eve/context`)
- `getSandbox()` — live sandbox handle for the current agent (`eve/sandbox`)
- `getSkill(identifier)` — handle for a named skill visible to the current agent (`eve/skills`)
- `getContext(key)`, `requireContext(key)`, `hasContext(key)`, `setContext(key)`, `ensureContext(key, factory)` — unified context helpers (`eve/context`)

The complete API reference, including types and lower-level runtime primitives, is in [`./docs/reference/typescript-api.md`](./docs/reference/typescript-api.md).

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
});
```

## Quick Start

```bash
npx eve@latest init my-agent
```

`eve init` writes a new agent with eve's default model. Pass `--channel-web-nextjs` to add the
Web Chat application. It installs dependencies, initializes Git, and starts the
development server. Targeting an existing project directory (`eve init .`) adds
the agent files and missing dependencies instead. It does not create a Vercel
project or deploy the agent.

CLI commands:

- `eve init <name>` — create a new agent
- `eve info` — discovery results and compiled artifacts
- `eve build` — compile `.eve/` and build the host output
- `eve start` — serve the built `.output/` app
- `eve dev` — start the local runtime and REPL

## Deploying

eve is built to be durable. The runtime is Nitro + Workflows. Read [`./docs/guides/deployment.md`](./docs/guides/deployment.md) for the deployment path, environment variables, and configuration.

## Read Next

These files ship inside the installed package at `node_modules/eve/docs/`:

- [Full docs index](./docs/README.md) — recommended entry point
- [Getting Started](./docs/getting-started.mdx) — install, scaffold, and run locally
- [Project Layout](./docs/reference/project-layout.md) — every authored directory in depth
- [`agent.ts`](./docs/agent-config.md) — agent config reference
- [TypeScript API](./docs/reference/typescript-api.md) — complete `define*` and runtime helper reference
- [Vercel Deployment](./docs/guides/deployment.md) — deploy to production

By authoring concern: [Tools](./docs/tools.mdx) · [Channels](./docs/channels/overview.mdx) · [Hooks](./docs/guides/hooks.md) · [Skills](./docs/skills.mdx) · [Sandbox](./docs/sandbox.mdx) · [Connections](./docs/connections.mdx) · [Subagents](./docs/subagents.mdx) · [Schedules](./docs/schedules.mdx) · [Evals](./docs/evals/overview.mdx)

By runtime concern: [Sessions and Streaming](./docs/concepts/sessions-runs-and-streaming.md) · [Session Context](./docs/guides/session-context.md) · [Context Control](./docs/concepts/context-control.md) · [Auth and Route Protection](./docs/guides/auth-and-route-protection.md) · [CLI, Build, and Debugging](./docs/reference/cli.md) · [Instrumentation](./docs/guides/instrumentation.md)

## Architecture (Internals)

You do not need this section to author an eve agent — it documents the public HTTP protocol contracts so eve composes predictably with other systems.

eve's internal split is:

- the **channel** normalizes inbound transport, applies auth and delivery policy, and owns `continuationToken`
- the **harness** does one unit of AI work and returns `{ session, next }`
- the **runtime** persists state, follows `next`, streams events, and owns workflow primitives (`start()`, `resumeHook()`, `createHook()`, `getWritable()`)

That split is why the public HTTP protocol separates two distinct identifiers:

- `continuationToken` — channel-owned handle the caller uses to start the next user turn
- `sessionId` — runtime-owned handle for streaming and inspection

## Changelog

See [`./CHANGELOG.md`](./CHANGELOG.md) for the release history. The changelog ships inside the published package so agents can read it directly from `node_modules/eve/CHANGELOG.md` to evaluate upgrades.
