const EVE_ORIGIN = "https://eve.dev";

export const createLlmsIndex = (): string => `# eve

> eve is a filesystem-first, Apache-2.0 framework for building durable backend AI agents that run on Vercel or self-hosted infrastructure. eve is currently in beta.

Use this file to choose the smallest relevant documentation set. Use \`/sitemap.md\` for the exhaustive page map and \`/llms-full.txt\` only for offline indexing or a large context window. For an installed project, prefer \`node_modules/eve/docs/\`: those docs match the installed eve version, while eve.dev documents the latest release.

eve.dev publishes framework documentation. It is not a shared API, authorization server, MCP server, or A2A server. Every deployed eve app exposes its own \`/eve/v1\` routes and authentication policy. External API, OpenAPI, and MCP URLs in these docs describe third-party connections or examples unless stated otherwise.

Documentation links below point directly to Markdown. Remove the \`.md\` suffix for the canonical HTML page.

## Start here

- [Getting started](${EVE_ORIGIN}/docs/getting-started.md): Choose the right path for a new or existing eve project.
- [Installation](${EVE_ORIGIN}/docs/installation.md): Create a project, configure a model credential, and run it locally.
- [Project structure](${EVE_ORIGIN}/docs/project-structure.md): Learn which files eve discovers and how paths define capabilities.
- [First-agent tutorial](${EVE_ORIGIN}/docs/tutorial/first-agent.md): Build an agent with tools, durable state, and an interface.

## Author an agent

- [Agent configuration](${EVE_ORIGIN}/docs/agent-config.md): Configure the model, reasoning effort, compaction, and runtime behavior.
- [Instructions](${EVE_ORIGIN}/docs/instructions.md): Write the agent's always-on system prompt.
- [Tools](${EVE_ORIGIN}/docs/tools.md): Define typed actions and gate sensitive calls on human approval.
- [Skills](${EVE_ORIGIN}/docs/skills.md): Add procedures that the model loads on demand.
- [Channels](${EVE_ORIGIN}/docs/channels/overview.md): Expose the agent through HTTP, Slack, Discord, and other messaging surfaces.
- [Connections](${EVE_ORIGIN}/docs/connections.md): Connect external MCP and OpenAPI servers without exposing credentials to the model.
- [Extensions](${EVE_ORIGIN}/docs/extensions.md): Package and mount reusable eve capabilities.
- [Sandbox](${EVE_ORIGIN}/docs/sandbox.md): Configure the isolated shell, filesystem, lifecycle, and network policy.
- [Subagents](${EVE_ORIGIN}/docs/subagents.md): Delegate work to copies of the root agent or declared specialists.
- [Schedules](${EVE_ORIGIN}/docs/schedules.md): Run prompts or handlers on a cron cadence.
- [Evals](${EVE_ORIGIN}/docs/evals/overview.md): Define repeatable scored checks and run them with \`eve eval\`.

## Connect clients and interfaces

- [Base eve channel](${EVE_ORIGIN}/docs/channels/eve.md): Understand the HTTP API exposed by each running eve app.
- [Frontend overview](${EVE_ORIGIN}/docs/guides/frontend/overview.md): Build browser chat interfaces with \`useEveAgent\`.
- [Next.js](${EVE_ORIGIN}/docs/guides/frontend/nextjs.md): Mount eve routes and use the React client in Next.js.
- [Nuxt](${EVE_ORIGIN}/docs/guides/frontend/nuxt.md): Mount eve routes and use the Vue client in Nuxt.
- [SvelteKit](${EVE_ORIGIN}/docs/guides/frontend/sveltekit.md): Mount eve routes and use the Svelte client in SvelteKit.
- [TypeScript SDK](${EVE_ORIGIN}/docs/guides/client/overview.md): Call an eve app from scripts, services, tests, or custom UIs.
- [Sessions, runs, and streaming](${EVE_ORIGIN}/docs/concepts/sessions-runs-and-streaming.md): Understand continuation tokens, stream handles, NDJSON events, and reconnecting.
- [Authentication and route protection](${EVE_ORIGIN}/docs/guides/auth-and-route-protection.md): Secure a deployed app's routes and connection OAuth.

## Run and operate

- [Execution model and durability](${EVE_ORIGIN}/docs/concepts/execution-model-and-durability.md): Understand sessions, checkpointed steps, and parked work.
- [Default harness](${EVE_ORIGIN}/docs/concepts/default-harness.md): Understand the built-in loop, tools, workspace, and context assembly.
- [Context control](${EVE_ORIGIN}/docs/concepts/context-control.md): Control context growth, compaction, and model-visible history.
- [Security model](${EVE_ORIGIN}/docs/concepts/security-model.md): Review trust boundaries, secret handling, credentials, and fail-closed behavior.
- [Deployment overview](${EVE_ORIGIN}/docs/guides/deployment/overview.md): Choose between Vercel and self-hosted infrastructure.
- [Deploy to Vercel](${EVE_ORIGIN}/docs/guides/deployment/vercel.md): Build and deploy with Vercel Workflow and Vercel Sandbox.
- [Self-hosting](${EVE_ORIGIN}/docs/guides/deployment/self-hosting.md): Run eve as a Node service or container.
- [Instrumentation](${EVE_ORIGIN}/docs/guides/instrumentation.md): Trace agents with OpenTelemetry and inspect workflow metadata.
- [Hooks](${EVE_ORIGIN}/docs/guides/hooks.md): Subscribe to runtime stream events.
- [Durable state](${EVE_ORIGIN}/docs/guides/state.md): Persist per-session memory across step boundaries.
- [Dynamic capabilities](${EVE_ORIGIN}/docs/guides/dynamic-capabilities.md): Resolve models, tools, skills, subagents, and instructions at runtime.
- [Remote agents](${EVE_ORIGIN}/docs/guides/remote-agents.md): Call another eve deployment as a subagent.

## Reference and discovery

- [TypeScript API](${EVE_ORIGIN}/docs/reference/typescript-api.md): Find public \`define*\` helpers, runtime context, and import paths.
- [CLI reference](${EVE_ORIGIN}/docs/reference/cli.md): Find every eve command and option.
- [Project layout reference](${EVE_ORIGIN}/docs/reference/project-layout.md): Look up authored slots and path-derived naming rules.
- [Install integrations](${EVE_ORIGIN}/docs/install-integrations.md): Discover and add official or third-party integrations.
- [Documentation map](${EVE_ORIGIN}/sitemap.md): Browse every documentation, integration, and template page with type and summary metadata.
- [Agent instructions](${EVE_ORIGIN}/agents.md): Read operational guidance for coding agents working with eve.
- [Full documentation corpus](${EVE_ORIGIN}/llms-full.txt): Load all docs and integration content for offline indexing or a large context window.

## Optional

- [Integrations](${EVE_ORIGIN}/integrations): Browse official channels, connections, extensions, and instrumentation providers.
- [Templates](${EVE_ORIGIN}/templates): Browse complete example projects and their source.
- [Official eve skill](https://github.com/vercel/eve/blob/main/skills/eve/SKILL.md): Install or inspect the coding-agent skill; its guidance defers to version-matched bundled docs.
- [Source repository](https://github.com/vercel/eve): Read source, releases, issues, and contribution guidance.
`;
