# eve Public Docs

This folder is for app authors using eve as a framework.

If you want to understand how to build agents with eve, start here.

Important naming note:

- The framework is called eve.
- The current published package name is `eve`.
- The CLI binary is `eve`.

## Legal and safeguards

eve is currently a preview and subject to the Vercel beta terms; the framework, APIs, documentation, and behavior may change before general availability.

As the deployer, it is your responsibility to ensure your agent complies with applicable laws.

You are responsible for configuring approval policies, tool restrictions, connection scopes, route/session authorization, sandbox controls, telemetry exports, and other safeguards appropriate for your use case.

Before using eve with non-public, sensitive, regulated, or production data, review which default tools, custom tools, MCP tools, shell/file/web tools, connected services, subagents, schedules, and external actions are available to the agent.

Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

Unless you configure stricter controls, eve agents may operate with permissive settings, including tool execution without human approval where approval is omitted and sandbox network egress that is not deny-all. Do not rely on model behavior alone to prevent sensitive or irreversible actions.

Casing convention:

- Use Title Case for page `title` frontmatter and `meta.json` section titles (Fumadocs renders the page `title` as both the sidebar entry and the `<h1>`, so one casing covers both) — e.g. `Execution Model & Durability`, `Dynamic Capabilities`, `Build an Agent`.
- Use sentence case for in-page headings (`##` and below). Capitalize only the first word plus proper nouns/acronyms — e.g. `Next.js`, `SvelteKit`, `Slack`, `GitHub`, `CLI`, `TypeScript API`, `agent.ts`.

## Read this first

Read in this order:

1. [Introduction](./introduction.md)
2. [Getting Started](./getting-started.mdx)
3. [Project Layout](./reference/project-layout.md)
4. [`agent.ts`](./agent-config.md)
5. [TypeScript API](./reference/typescript-api.md)
6. [Context Control](./concepts/context-control.md)
7. [Skills](./skills.mdx)
8. [Tools](./tools/overview.mdx)
9. [Connections](./connections.mdx)
10. [Sandboxes](./sandbox.mdx)
11. [Channels](./channels/overview.mdx)
12. [Session Context](./reference/typescript-api.md)
13. [Sessions And Streaming](./concepts/sessions-runs-and-streaming.md)
14. [TypeScript SDK](./clients/typescript-sdk/overview.mdx)
15. [Subagents](./subagents.mdx)
16. [Schedules](./schedules.mdx)
17. [Evals](./evals/overview.mdx)
18. [Auth And Route Protection](./develop/auth-and-route-protection.md)
19. [Vercel Deployment](./develop/deployment.md)
20. [CLI, Build, And Debugging](./reference/cli.md)

## The public mental model

eve is a filesystem-first framework for durable backend agents.

You author an agent as files on disk:

- instructions in `instructions.md` or `instructions.ts`
- optional procedures in `skills/`
- typed integrations in `tools/`
- external MCP servers in `connections/`
- the per-agent sandbox override in `sandbox/`
- messaging integrations in `channels/`
- shared authored code in `lib/`
- specialist child agents in `subagents/`
- recurring jobs in `schedules/`
- additive runtime config in `agent.ts`

eve then gives you:

- a stable HTTP message route
- optional channel webhook routes
- a reconnectable session stream
- durable session state across turns
- a per-agent sandbox with a shared runtime workspace
- typed runtime helpers accessed through `ctx` (`ctx.session`, `ctx.getSandbox()`, `ctx.getSkill()`)

## The runtime shape

The public surface stays filesystem-first, but the implementation model underneath is still useful to
know:

- channels normalize inbound transport input and define the `continuationToken`
- the harness does one unit of AI work and decides whether to continue, wait, or finish
- the runtime persists session state, streams events, and owns workflow orchestration

That is why eve exposes two identifiers:

- `continuationToken` for the next user message
- `sessionId` for streaming and inspection

## How to use these docs

- Start with the authored filesystem shape and `agent.ts`.
- Then add runtime surfaces in this order: skills, tools, workspace, sandbox, channels.
- Then learn the durable runtime model: HITL, session context, sessions, streaming, and
  continuation-token follow-ups.
- Then add advanced features: subagents, schedules, route protection, deployment.

## Good companions in this repo

- Weather-focused smoke/dev fixture: [`../../apps/fixtures/weather-fixture`](../../apps/fixtures/weather-fixture)
- Public API source of truth: [`../../packages/eve/src/public/index.ts`](../../packages/eve/src/public/index.ts)
