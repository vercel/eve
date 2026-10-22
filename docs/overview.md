---
title: "Overview"
description: "What eve runs for you, how one request moves through it, and how eve compares with AI SDK, libfx, and Workflow SDK."
---

eve is a TypeScript framework for building and running production AI agents. It runs the agent loop and the system around it: the channels where the agent talks, the schedules that start it, the approvals it waits for, the sandbox where it runs code, the durable sessions that survive restarts, and the evals that check its behavior. You deploy the result to Vercel or to your own infrastructure.

You author an agent as a directory. Filesystem conventions get an agent running from one Markdown file. Each convention also has a TypeScript form, and the runtime exposes typed resolvers, hooks, workflow tools, and clients for when the agent needs more control.

eve is in beta, so its APIs can change before general availability.

## What eve runs for you

| Concern           | What eve provides                                                                                                        | Where you configure it                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Agent loop        | Model calls, tool calls, context compaction, and delegation to subagents                                                 | `agent.ts`, `instructions.md`, `tools/`, `subagents/` |
| Durable execution | Sessions that checkpoint each step, park while they wait, and resume after crashes and redeploys                         | Built in                                              |
| Channels          | An HTTP API plus platform channels such as Slack, Discord, Microsoft Teams, Telegram, GitHub, and Twilio                 | `channels/`                                           |
| Triggers          | Cron schedules that start the agent without a user message                                                               | `schedules/`                                          |
| Human in the loop | Approval policies on tools and questions asked mid-turn, rendered by each channel                                        | A tool's `approval`, `ctx.ask` in workflow tools      |
| Sandbox           | An isolated shell and filesystem for each session, backed by a provider such as Vercel Sandbox or Docker                 | `sandbox/`                                            |
| Connections       | MCP and OpenAPI servers, with credentials kept out of the model's context and interactive sign-in that parks the turn    | `connections/`                                        |
| Evals             | Scored checks that drive real sessions through the agent's HTTP API                                                      | `evals/`, `eve eval`                                  |
| Observability     | Runtime event hooks, OpenTelemetry export, `eve logs`, and `eve traces`                                                  | `hooks/`, `instrumentation/`                          |
| Clients           | A typed TypeScript client, React, Vue, and Svelte hooks, and Agent Client Protocol (ACP) support for editors             | `eve/client`, `eve/react`, `eve/vue`, `eve/svelte`    |
| Auth              | Route auth on the HTTP API and channels, an authenticated principal on each session, and per-user connection credentials | `channels/eve.ts`, a channel's `auth`                 |
| Deployment        | `eve deploy` to Vercel, or `eve build` and `eve start` to run a self-hosted Node.js service                              | `eve deploy`, `eve start`                             |

## How a request runs

This example follows a support agent with a Slack channel, a `get_order` tool, and a `refund_charge` tool that requires approval from a billing lead.

1. Alice mentions the agent in a Slack thread and asks for a refund. The Slack channel maps the thread to a durable session and starts a turn.
2. The model calls `get_order`, then decides to call `refund_charge`. eve checkpoints each step, so if the process crashes or a deploy lands mid-turn, the run picks up from the last completed step instead of starting over.
3. `refund_charge` requires approval. The Slack channel posts an approval card, and the turn parks. A parked session holds no compute while it waits. By default only the person who asked can approve, so the tool's approval response policy allows billing leads to answer.
4. Bob, a billing lead, approves in the thread two hours later. The session resumes where it stopped, runs the refund, and replies in the same thread.
5. A hook in `agent/hooks/` receives each runtime event after eve records it, so you can write an audit log or alert on failures. An eval in `evals/` checks that refunds always wait for approval.

The same agent can answer in a web app through `useEveAgent`, run a weekly digest from `schedules/`, or take requests from another service through `eve/client`, without changing its tools or instructions. See [Execution Model and Durability](./concepts/execution-model-and-durability) for the full session lifecycle.

## Start with files, add TypeScript where you need control

Conventions cover the common case. When an agent needs more control, use the TypeScript API for that part of the runtime:

| To do this                                                                          | Use                                                                               |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Choose the model, tools, skills, subagents, connections, or instructions per caller | `defineDynamic`, in [Dynamic Capabilities](./guides/dynamic-capabilities)         |
| Wait for a person, webhook, or timer inside a tool without holding compute          | `defineWorkflowTool`, in [Workflows as Tools](./tools/workflows)                  |
| Keep the conversation going while long tool or subagent work runs                   | [Tasks](./tools/tasks)                                                            |
| Persist every runtime event to your database or trigger side effects                | `defineHook`, in [Hooks](./guides/hooks)                                          |
| Call the agent from a backend, script, or test and get typed structured output      | `Client` and `outputSchema`, in [Client SDK](./guides/client/overview)            |
| Mount the agent in a Next.js, Nuxt, SvelteKit, or TanStack Start app                | `withEve` and `useEveAgent`, in [Frontend Frameworks](./guides/frontend/overview) |
| Share tools, skills, channels, hooks, and subagents across agents as a package      | [Extensions](./extensions)                                                        |
| Call another eve deployment as a subagent                                           | `defineRemoteAgent`, in [Remote Agents](./guides/remote-agents)                   |

eve's coding agent, [eve-code](./code-extension), ships as an extension that you mount the same way as any other. The [TypeScript API Reference](./reference/typescript-api) lists every `define*` helper and where to import it.

## Where eve fits

eve, AI SDK, libfx, and Workflow SDK solve different parts of building an agent. Choose by how much of the system you want to build yourself.

| Tool                                     | What it gives you                                  | Choose it when                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [AI SDK](https://ai-sdk.dev)             | Model calls, streaming, and tool calling           | You want model access inside code you already run, and you plan to build the loop, persistence, and delivery yourself.                           |
| [libfx](https://fx.sh/docs/lib)          | A durable agent loop you embed in your own process | You want an agent loop inside an existing server, script, or browser page, and you plan to build the product around it.                          |
| eve                                      | The agent loop and the application around it       | You want to build and deploy the whole agent: where it talks, what starts it, when it waits for people, where it runs code, and how you test it. |
| [Workflow SDK](https://workflow-sdk.dev) | Durable functions with steps, hooks, and sleeps    | You need durable backend processes that are not agents. eve runs its sessions on Workflow SDK.                                                   |

### eve and AI SDK

eve makes its model calls through AI SDK. An agent's model can be an AI Gateway model ID or an AI SDK `LanguageModel`, so you can use any provider that AI SDK supports. Use AI SDK directly when you need model calls without sessions, channels, or a hosted runtime.

### eve and libfx

[libfx](https://fx.sh/docs/lib) is the agent engine from fx, the open-source coding agent from Vercel Labs, packaged as a JavaScript library for Node.js and WebAssembly. You give it a model, instructions, and tools, and it runs the conversation: the model loop, streaming, tool calls, retries, steering, and session storage that lets a turn continue after its process stops. libfx is designed to be embedded, so the routes, authentication, interface, and triggers around it are yours to build.

eve is a framework rather than an embeddable library. It owns the agent's HTTP routes, channels, schedules, human-in-the-loop flow, sandbox, evals, and deployment, and it defines one authoring format for all of them. eve also owns the agent loop: you configure it and program everything around it, but you do not replace it. If you need to own the loop itself, use libfx. eve and libfx are separate projects with separate runtimes.

### eve and Workflow SDK

eve runs every session as a durable workflow on the open-source [Workflow SDK](https://workflow-sdk.dev), which becomes Vercel Workflow when you deploy on Vercel. You do not write workflow code to get durable sessions. Use Workflow SDK directly for durable backend processes that are not agents, and use [workflow tools](./tools/workflows) when an agent needs to start one.

## What to read next

- [Getting Started](./getting-started): create a project and run your first agent.
- [Tutorial](./tutorial/first-agent): build an agent with tools, durable state, and an interface.
- [Project Structure](./concepts/project-structure): choose a layout for agents and application code.
- [Execution Model and Durability](./concepts/execution-model-and-durability): understand sessions, steps, and parked work.
