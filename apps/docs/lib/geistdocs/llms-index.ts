const EVE_ORIGIN = "https://eve.dev";

export const createLlmsIndex = (): string => `# eve

> eve is a filesystem-first, Apache-2.0 framework for building durable backend AI agents that run on Vercel or self-hosted infrastructure. eve is currently in beta.

Use this file to choose the smallest relevant documentation set. Use \`/sitemap.md\` for the exhaustive page map and \`/llms-full.txt\` only for offline indexing or a large context window. For an installed project, prefer \`node_modules/eve/docs/\`: those docs match the installed eve version, while eve.dev documents the latest release.

eve.dev publishes framework documentation. It is not a shared API, authorization server, MCP server, or A2A server. Every deployed eve app exposes its own \`/eve/v1\` routes and authentication policy. External API, OpenAPI, and MCP URLs in these docs describe third-party connections or examples unless stated otherwise.

Documentation links below point directly to Markdown. Remove the \`.md\` suffix for the canonical HTML page.

## Introduction

- [Getting Started](${EVE_ORIGIN}/docs/getting-started.md): Create a project, configure a model, understand its layout, and run it locally.

## Core Concepts

- [Execution Model and Durability](${EVE_ORIGIN}/docs/concepts/execution-model-and-durability.md): Understand sessions, checkpointed steps, and parked work.
- [Sessions, Runs, and Streaming](${EVE_ORIGIN}/docs/concepts/sessions-runs-and-streaming.md): Understand session IDs, NDJSON events, controls, and reconnecting.
- [Default Harness](${EVE_ORIGIN}/docs/concepts/default-harness.md): Understand the built-in loop, tools, workspace, and context assembly.
- [Context Control](${EVE_ORIGIN}/docs/concepts/context-control.md): Choose what the model sees and when.
- [Security Model](${EVE_ORIGIN}/docs/concepts/security-model.md): Review trust boundaries, secret handling, credentials, and fail-closed behavior.

## Build

- [Agents](${EVE_ORIGIN}/docs/agent-config.md): Configure the model, reasoning effort, compaction, and runtime behavior.
- [Instructions](${EVE_ORIGIN}/docs/instructions.md): Write the agent's always-on system prompt.
- [Tools](${EVE_ORIGIN}/docs/tools.md): Define typed actions and gate sensitive calls on human approval.
- [Connections](${EVE_ORIGIN}/docs/connections.md): Connect external MCP and OpenAPI servers without exposing credentials to the model.
- [Channels](${EVE_ORIGIN}/docs/channels/overview.md): Expose the agent through HTTP, Slack, Discord, and other messaging surfaces.
- [Base eve Channel](${EVE_ORIGIN}/docs/channels/eve.md): Understand the HTTP API exposed by each running eve app.
- [Skills](${EVE_ORIGIN}/docs/skills.md): Add procedures that the model loads on demand.
- [Sandbox](${EVE_ORIGIN}/docs/sandbox.md): Configure the isolated shell, filesystem, lifecycle, and network policy.
- [Subagents](${EVE_ORIGIN}/docs/subagents.md): Delegate work to copies of the root agent or declared specialists.
- [Evals](${EVE_ORIGIN}/docs/evals/overview.md): Define repeatable scored checks and run them with \`eve eval\`.
- [Durable State](${EVE_ORIGIN}/docs/concepts/state.md): Persist per-session memory across step boundaries.
- [Session Context](${EVE_ORIGIN}/docs/guides/session-context.md): Use session metadata and runtime accessors in authored code.
- [Schedules](${EVE_ORIGIN}/docs/schedules.md): Run prompts or handlers on a cron cadence.
- [Hooks](${EVE_ORIGIN}/docs/guides/hooks.md): Subscribe to runtime stream events.
- [Dynamic Capabilities](${EVE_ORIGIN}/docs/guides/dynamic-capabilities.md): Resolve models, tools, skills, subagents, and instructions at runtime.
- [Workflow Tool](${EVE_ORIGIN}/docs/subagents/workflow-tool.md): Let the model orchestrate subagents through the experimental Workflow tool.

## Integrate

- [Add Integrations](${EVE_ORIGIN}/docs/install-integrations.md): Discover and add official or third-party integrations.
- [Extensions](${EVE_ORIGIN}/docs/extensions.md): Package and mount reusable eve capabilities.
- [Remote Agents](${EVE_ORIGIN}/docs/guides/remote-agents.md): Call another eve deployment as a subagent.
- [Agent Client Protocol (ACP)](${EVE_ORIGIN}/docs/protocols/acp.md): Use local or deployed eve agents from ACP clients.
- [Universal Commerce Protocol (UCP)](${EVE_ORIGIN}/docs/protocols/ucp.md): Serve a UCP profile from a custom eve channel.
- [Frontend Frameworks](${EVE_ORIGIN}/docs/guides/frontend/overview.md): Build browser chat interfaces with \`useEveAgent\`.
- [Next.js](${EVE_ORIGIN}/docs/guides/frontend/nextjs.md): Mount eve routes and use the React client in Next.js.
- [Nuxt](${EVE_ORIGIN}/docs/guides/frontend/nuxt.md): Mount eve routes and use the Vue client in Nuxt.
- [SvelteKit](${EVE_ORIGIN}/docs/guides/frontend/sveltekit.md): Mount eve routes and use the Svelte client in SvelteKit.
- [Client SDK](${EVE_ORIGIN}/docs/guides/client/overview.md): Call an eve app from scripts, services, tests, or custom UIs.

## Operate

- [Deployment Overview](${EVE_ORIGIN}/docs/guides/deployment/overview.md): Choose between Vercel and self-hosted infrastructure.
- [Deploy to Vercel](${EVE_ORIGIN}/docs/guides/deployment/vercel.md): Build and deploy with Vercel Workflow and Vercel Sandbox.
- [Self-Hosting](${EVE_ORIGIN}/docs/guides/deployment/self-hosting.md): Run eve as a Node service or container.
- [Authentication](${EVE_ORIGIN}/docs/guides/auth-and-route-protection.md): Secure an agent's HTTP routes and establish caller identity.
- [Observability](${EVE_ORIGIN}/docs/guides/instrumentation.md): Trace agents with OpenTelemetry and inspect workflow metadata.
- [Terminal UI](${EVE_ORIGIN}/docs/guides/dev-tui.md): Work with a local or deployed agent from the interactive terminal UI.

## Reference

- [Tutorial](${EVE_ORIGIN}/docs/tutorial/first-agent.md): Build an agent with tools, durable state, and an interface.

## Patterns

- [Multi-Tenant Memory](${EVE_ORIGIN}/docs/patterns/multi-tenant-memory.md): Compose tenant-scoped long-term memory from dynamic instructions and tools.
- [Dynamic Scheduling](${EVE_ORIGIN}/docs/patterns/dynamic-scheduling.md): Build application-managed schedules from an eve schedule and authored tools.
- [Multi-Tenant Outbound Auth](${EVE_ORIGIN}/docs/patterns/multi-tenant-auth.md): Select tenant-scoped credentials for tools and connections.
- [Multi-Tenant Approvals](${EVE_ORIGIN}/docs/patterns/multi-tenant-approvals.md): Apply tenant policy to authored and connection tools.

## API Reference and Discovery

- [TypeScript API Reference](${EVE_ORIGIN}/docs/reference/typescript-api.md): Find public \`define*\` helpers, runtime context, and import paths.
- [CLI Reference](${EVE_ORIGIN}/docs/reference/cli.md): Find every eve command and option.
- [Responsible Use](${EVE_ORIGIN}/docs/responsible-use.md): Review deployer responsibilities and safeguards.
- [Documentation Map](${EVE_ORIGIN}/sitemap.md): Browse every documentation, integration, and template page with type and summary metadata.
- [Agent Instructions](${EVE_ORIGIN}/agents.md): Read operational guidance for coding agents working with eve.
- [Full Documentation Corpus](${EVE_ORIGIN}/llms-full.txt): Load all docs and integration content for offline indexing or a large context window.

## Optional

- [Integrations](${EVE_ORIGIN}/integrations): Browse official channels, connections, extensions, and instrumentation providers.
- [Templates](${EVE_ORIGIN}/templates): Browse complete example projects and their source.
- [Official eve Skill](https://github.com/vercel/eve/blob/main/skills/eve/SKILL.md): Install or inspect the coding-agent skill; its guidance defers to version-matched bundled docs.
- [Source Repository](https://github.com/vercel/eve): Read source, releases, issues, and contribution guidance.
`;
