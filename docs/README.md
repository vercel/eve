# eve Public Docs

This folder is for app authors using eve as a framework.

If you want to understand how to build agents with eve, start here.

Important naming note:

- The framework is called eve.
- The current published package name is `eve`.
- The CLI binary is `eve`.

## Find the page for your task

| To do this                                               | Read this                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Create a project, or understand the file layout          | [Getting Started](./getting-started.mdx)                                               |
| Set the model, reasoning, or other agent-wide config     | [Agents](./agent-config.md)                                                            |
| Change what the agent does and how it behaves            | [Instructions](./instructions.mdx)                                                     |
| Give the agent a typed capability it can call            | [Tools](./tools/overview.mdx)                                                          |
| Require approval, or ask the user something mid-turn     | [Human in the Loop](./tools/human-in-the-loop.md)                                      |
| Call an external HTTP API or MCP server                  | [Connections](./connections/overview.mdx)                                              |
| Add a messaging surface (Slack, Discord, iMessage, …)    | [Channels](./channels/overview.mdx)                                                    |
| Expose your own HTTP route as a conversation surface     | [Custom Channels](./channels/custom.mdx)                                               |
| Package a procedure the agent loads only when it applies | [Skills](./skills.mdx)                                                                 |
| Carry state across turns, or shape what the model sees   | [State](./concepts/state.md), [Context Control](./concepts/context-control.md)         |
| Run commands or untrusted code in isolation              | [Sandboxes](./sandbox.mdx)                                                             |
| Delegate work to a specialist child agent                | [Subagents](./subagents/index.mdx)                                                     |
| Run work on a recurring schedule                         | [Schedules](./schedules.mdx)                                                           |
| Install an existing integration instead of writing one   | [Add Integrations](./install-integrations.mdx)                                         |
| Link a Vercel project and deploy to production           | [Deploy to Vercel](./guides/deployment/vercel.mdx)                                     |
| Self-host, or compare hosting strategies                 | [Deployment](./guides/deployment/overview.md)                                          |
| Authorize routes, sessions, and per-user access          | [Authentication](./guides/auth-and-route-protection.md)                                |
| Build a web UI, or stream a session to a client          | [Client SDK](./guides/client/overview.mdx), [Frontend](./guides/frontend/overview.mdx) |
| Test the agent's behavior                                | [Evals](./evals/overview.mdx)                                                          |
| Look up a CLI command or an exported type                | [CLI](./reference/cli.md), [TypeScript API](./reference/typescript-api.md)             |

## Legal and safeguards

eve is in preview; the framework, APIs, documentation, and behavior may change before general availability.

As the deployer, it is your responsibility to ensure your agent complies with applicable laws.

You are responsible for configuring approval policies, tool restrictions, connection scopes, route/session authorization, sandbox controls, telemetry exports, and other safeguards appropriate for your use case.

Before using eve with non-public, sensitive, regulated, or production data, review which default tools, custom tools, MCP tools, shell/file/web tools, connected services, subagents, schedules, and external actions are available to the agent.

Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

Unless you configure stricter controls, eve agents may operate with permissive settings, including tool execution without human approval where approval is omitted and sandbox network egress that is not deny-all. Do not rely on model behavior alone to prevent sensitive or irreversible actions.

## Read this first

For a full picture rather than a single task, read in this order:

1. [Getting Started](./getting-started.mdx)
2. [Tutorial](./tutorial/first-agent.mdx)
3. [Agents](./agent-config.md)
4. [TypeScript API Reference](./reference/typescript-api.md)
5. [Context Control](./concepts/context-control.md)
6. [Skills](./skills.mdx)
7. [Tools](./tools/overview.mdx)
8. [Connections](./connections/overview.mdx)
9. [Sandboxes](./sandbox.mdx)
10. [Channels](./channels/overview.mdx)
11. [Session Context](./guides/session-context.md)
12. [Sessions and Streaming](./concepts/sessions-runs-and-streaming.md)
13. [Client SDK](./guides/client/overview.mdx)
14. [Subagents](./subagents/index.mdx)
15. [Schedules](./schedules.mdx)
16. [Evals](./evals/overview.mdx)
17. [Authentication](./guides/auth-and-route-protection.md)
18. [Deployment](./guides/deployment/overview.md)
19. [CLI](./reference/cli.md)

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

- channels normalize inbound transport input and map platform addresses to sessions
- the harness does one unit of AI work and decides whether to continue, wait, or finish
- the runtime persists session state, streams events, and owns workflow orchestration

The default HTTP API exposes one durable `sessionId` for messages, controls, and
streaming. Platform channels additionally own channel-local continuation
addresses so a Slack thread or custom conversation ID can point at its current
session without leaking that routing identity into the HTTP client contract.

## How to use these docs

- Start with the authored filesystem shape and `agent.ts`.
- Then add runtime surfaces in this order: skills, tools, workspace, sandbox, channels.
- Then learn the durable runtime model: HITL, session context, sessions, streaming, and
  ID-addressed follow-ups and channel address routing.
- Then add advanced features: subagents, schedules, route protection, deployment.
