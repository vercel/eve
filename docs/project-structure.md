---
title: "Project Structure"
description: "Organize one or more independently addressed eve agents in a project, select them with the CLI, and deploy them together."
---

An eve project can contain one root agent or several peer root agents. Use a multi-agent project when the agents should share one project environment and deployment but keep separate instructions, capabilities, sessions, and public routes.

A peer agent is not a [subagent](./subagents). Peer agents are independently addressed root agents. A subagent is a child capability that one root agent can call.

## Choose a project shape

| Shape                        | Use it when                                                                | Agent location                          | Default public route                      |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| Standalone agent             | One root agent has its own project and deployment                          | `agent/`                                | `/eve/v1/*`                               |
| Hostless multi-agent project | Several peer agents deploy together without a frontend                     | `agents/<name>/agent/`                  | `/<name>/eve/v1/*`                        |
| Frontend with named agents   | A framework application owns the public site and mounts one or more agents | Configured by the framework integration | `/eve/agents/<name>/eve/v1/*` for Next.js |

Keep agents in separate projects when they need separate Vercel projects, environment ownership, or deployment lifecycles. A package-manager monorepo can contain several standalone eve projects without making them one eve multi-agent project.

## Standalone project

A standalone project has one authored agent root:

```text
support-agent/
├── package.json
├── agent/
│   ├── agent.ts
│   ├── instructions.md
│   ├── channels/
│   ├── connections/
│   ├── skills/
│   └── tools/
└── evals/
```

Run agent and project commands from the same project root. The HTTP API is mounted at `/eve/v1/*` unless a host integration gives it another prefix.

See [Getting Started](./getting-started#project-layout) for every supported path under `agent/`.

## Multi-agent project

A hostless multi-agent project puts each peer under `agents/<name>/`. Each peer has a complete `agent/` tree and can have its own `evals/`:

```text
customer-operations/
├── package.json
├── tsconfig.json
├── agents/
│   ├── support/
│   │   ├── agent/
│   │   │   ├── instructions.md
│   │   │   ├── channels/
│   │   │   └── tools/
│   │   └── evals/
│   └── billing/
│       ├── agent/
│       │   ├── instructions.md
│       │   ├── connections/
│       │   └── skills/
│       └── evals/
└── packages/
    └── shared-capabilities/
```

The project root owns the eve dependency, environment files, Vercel link, and deployment. Every direct, discoverable child of `agents/` is a workspace member. Its directory name selects the member in the CLI and becomes its public URL segment. Use lowercase letters, numbers, underscores, or hyphens, starting and ending with a letter or number. A multi-agent project has no implicit primary agent.

Do not put an independent eve project directly under the multi-agent project's `agents/` directory. A child with its own `package.json` and `eve` dependency is a separate project boundary rather than a member of the enclosing project.

### Create the project

Pass comma-separated names to `eve init`:

```bash
npx eve@latest init customer-operations --agents support,billing
cd customer-operations
```

To add another peer later, run `eve init` from the multi-agent project root with the new name:

```bash
eve init research
```

This adds `agents/research/agent/` without replacing the project package, dependencies, or TypeScript configuration. Add `agents/research/evals/` when the new agent needs evals.

### Work with one agent

Pass `--agent <name>` to an agent-specific command at the project root:

```bash
eve dev --agent support
eve info --agent billing
eve eval --agent research
```

You can instead run the command from that member's directory:

```bash
cd agents/support
eve dev
```

When an interactive command runs at the project root and more than one agent exists, eve opens a picker. A non-interactive command cannot use the picker, so pass `--agent <name>`. If the project has only one member, eve selects it automatically.

### Work with the whole project

Project-level Vercel commands run from the project root:

| Task                                               | Run from                                                    | Result                                                    |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| Develop, inspect, configure, or evaluate one agent | Project root with `--agent <name>`, or the member directory | Selects one peer agent                                    |
| Link to Vercel                                     | Project root                                                | Links the shared Vercel project and pulls its environment |
| Build for Vercel                                   | Project root                                                | Builds every peer into one Vercel service graph           |
| Deploy to Vercel                                   | Project root                                                | Deploys every peer together                               |

`eve link` and `eve deploy` reject a member directory because the Vercel project belongs to the multi-agent project root. Run those commands from the root instead.

## Understand ownership and isolation

Peer agents share the project boundary but not their authored agent surfaces:

| Resource                                                                 | Ownership                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| Vercel project, deployment, and environment                              | Shared by the project                          |
| Root package, dependencies, and build scripts                            | Shared by the project                          |
| Instructions, tools, connections, channels, skills, hooks, and schedules | Owned by each agent                            |
| Sessions and subagents                                                   | Owned by each agent                            |
| Sandbox definition and session sandboxes                                 | Owned by each agent                            |
| Evals                                                                    | Owned by each agent under its member directory |
| Default memory namespace                                                 | Separate for each workspace agent              |

A peer does not automatically see or call its siblings. To let one deployed agent call another, declare the target as a [remote agent](./guides/remote-agents) and configure the required authentication.

## Share capabilities deliberately

Use an [extension](./extensions) when several agents need the same tools, connections, skills, hooks, instructions, schedules, or declared subagents. Keep the extension in a package under the same package-manager workspace, install it from the project root, and mount it separately in each consuming agent:

```text
customer-operations/
├── agents/
│   ├── support/agent/extensions/shared.ts
│   └── billing/agent/extensions/shared.ts
└── packages/
    └── shared-capabilities/
        ├── package.json
        └── extension/
```

```ts title="agents/support/agent/extensions/shared.ts"
export { default } from "@acme/shared-capabilities";
```

Each mount has its own namespace and belongs only to that agent. See [Use an extension in a workspace](./extensions#use-an-extension-in-a-workspace) for package and build configuration.

## Address deployed agents

A hostless multi-agent deployment prefixes each agent's eve API with its member name:

```text
https://customer-operations.vercel.app/support/eve/v1/*
https://customer-operations.vercel.app/billing/eve/v1/*
```

Check or open one agent by including that prefix:

```bash
curl https://customer-operations.vercel.app/support/eve/v1/health
eve dev https://customer-operations.vercel.app/support
eve eval --url https://customer-operations.vercel.app/billing
```

A frontend integration can use a different named route shape. For example, [`withEve({ agents })`](./guides/frontend/nextjs) mounts Next.js agents under `/eve/agents/<name>/eve/v1/*`, and the frontend hook selects one by name:

```tsx
import { useEveAgent } from "eve/react";

const support = useEveAgent({ agent: "support" });
```

Use the route shape defined by the deployment topology. The `agent` hook option selects a framework-mounted named agent; it does not select a hostless `/<name>` route.

## Choose peers or subagents

| Requirement                                                                             | Use                                                              |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| An independently addressed root agent with its own channels, sessions, and public route | Peer agent under `agents/<name>/`                                |
| A specialist available only to one parent agent                                         | [Declared subagent](./subagents#declared-subagents)              |
| An independently deployed agent called through another agent's tool surface             | [Remote agent](./guides/remote-agents)                           |
| A parallel copy of the root agent working with the same capabilities and sandbox        | The built-in [`agent` tool](./subagents#the-built-in-agent-tool) |

A root agent can combine these patterns. For example, the `support` peer can own a local `triage` subagent and call an independently deployed fulfillment agent remotely.

## Troubleshooting

| Symptom                                                        | Check                                                        | Next action                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| A non-interactive command says it requires a specific agent    | The project has multiple peers and no selection was supplied | Add `--agent <name>` or run from `agents/<name>/`                                                                  |
| `eve link` or `eve deploy` rejects the member directory        | The member belongs to a multi-agent project                  | Run the command from the project root                                                                              |
| A capability is available to one peer but missing from another | Peer agents do not inherit authored capabilities             | Author it in both agents or mount a shared extension in both                                                       |
| A deployed health URL returns `404`                            | The URL may use the wrong topology's prefix                  | Use `/<name>/eve/v1/health` for a hostless project or `/eve/agents/<name>/eve/v1/health` for a named Next.js mount |
| A sibling cannot be called as a tool                           | Peer agents are not automatically connected                  | Declare it as a remote agent and configure authentication                                                          |

## What to read next

- [Deploy to Vercel](./guides/deployment/vercel): link, build, and deploy the complete project.
- [Extensions](./extensions): share packaged capabilities across agents.
- [Subagents](./subagents): delegate work inside one root agent.
- [Next.js](./guides/frontend/nextjs): mount multiple agents behind a frontend application.
