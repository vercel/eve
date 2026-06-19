---
title: "TypeScript API"
description: "The define* helpers, the runtime ctx, and where each one is imported from."
---

This is the public surface of the `eve` package: the `define*` helpers you author with, the `ctx` they receive at runtime, and the import path for each. The full contract lives in `packages/eve/src/public/index.ts`; anything not exported there is a framework internal.

Identity comes from the filesystem, not a field you set. A tool at `agent/tools/get_weather.ts` is `get_weather`, and a connection at `agent/connections/linear.ts` is `linear`, so no definition carries a `name` or `id`.

Most files look the same: import a helper, default-export the result.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({ model: "anthropic/claude-opus-4.8" });
```

```ts title="agent/tools/get_weather.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Get the weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  async execute({ city }, ctx) {
    return { city, condition: "Sunny" };
  },
});
```

## The define\* helpers

| Helper                                                 | Import from                                   | Authored at                          | Guide                                                  |
| ------------------------------------------------------ | --------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `defineAgent`                                          | `eve`                                         | `agent/agent.ts`                     | [agent.ts](../agent-config)                            |
| `defineTool`                                           | `eve/tools`                                   | `agent/tools/<name>.ts`              | [Tools](../tools)                                      |
| `defineDynamic`                                        | `eve/tools`, `eve/skills`, `eve/instructions` | `agent/{tools,skills,instructions}/` | [Dynamic capabilities](../guides/dynamic-capabilities) |
| `defineMcpClientConnection`, `defineOpenAPIConnection` | `eve/connections`                             | `agent/connections/<name>.ts`        | [Connections](../connections)                          |
| `defineChannel`                                        | `eve/channels`                                | `agent/channels/<name>.ts`           | [Custom channels](../channels/custom)                  |
| `eveChannel`, `slackChannel`, and the other platforms  | `eve/channels/<platform>`                     | `agent/channels/<platform>.ts`       | [Channels](../channels/overview)                       |
| `defineSkill`                                          | `eve/skills`                                  | `agent/skills/<name>.ts`             | [Skills](../skills)                                    |
| `defineInstructions`                                   | `eve/instructions`                            | `agent/instructions.ts`              | [Instructions](../instructions)                        |
| `defineHook`                                           | `eve/hooks`                                   | `agent/hooks/<slug>.ts`              | [Hooks](../guides/hooks)                               |
| `defineSchedule`                                       | `eve/schedules`                               | `agent/schedules/<name>.ts`          | [Schedules](../schedules)                              |
| `defineState`                                          | `eve/context`                                 | tools, hooks, lifecycle              | [Session context](../guides/session-context)           |
| `defineSandbox`                                        | `eve/sandbox`                                 | `agent/sandbox.ts`                   | [Sandbox](../sandbox)                                  |
| `defineInstrumentation`                                | `eve/instrumentation`                         | `agent/instrumentation.ts`           | [instrumentation.ts](../guides/instrumentation)        |
| `defineRemoteAgent`                                    | `eve`                                         | `agent/subagents/<id>/agent.ts`      | [Remote agents](../guides/remote-agents)               |
| `defineEval`                                           | `eve/evals`                                   | `evals/*.eval.ts`                    | [Evals](../evals/overview)                             |
| `defineEvalConfig`                                     | `eve/evals`                                   | `evals/evals.config.ts`              | [Evals](../evals/overview)                             |
| `useEveAgent`                                          | `eve/react`, `eve/vue`, `eve/svelte`          | frontend                             | [Frontend](../guides/frontend/overview)                |

A few non-`define*` helpers round out the set: `disableTool` and `ExperimentalWorkflow` from `eve/tools` (see [Default harness](../concepts/default-harness)), the route verbs `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`WS` from `eve/channels`, the approval predicates `always`/`once`/`never` from `eve/tools/approval`, and the channel auth helpers `localDev`/`vercelOidc`/`placeholderAuth` from `eve/channels/auth`. To wrap a built-in tool, import its default value from `eve/tools/defaults` (`bash`, `readFile`, `writeFile`, `glob`, `grep`, `webFetch`, `webSearch`, `todo`, `loadSkill`). `AgentWorkflowDefinition` and `AgentWorkflowWorldDefinition` are exported from `eve` for the `defineAgent({ experimental: { workflow } })` config shape.

## Runtime context (`ctx`)

`ctx` is passed to your tool `execute`, hook handlers, and channel event handlers. It is live only while authored code is running, so reaching for it at module top level throws. See [Session context](../guides/session-context) for the full model.

| Member                     | Use                                                                           |
| -------------------------- | ----------------------------------------------------------------------------- |
| `ctx.session`              | Current session, turn, auth, and optional parent lineage (read-only)          |
| `ctx.getSandbox()`         | Live sandbox handle for the current agent                                     |
| `ctx.getSkill(identifier)` | Handle for a named skill visible to the current agent                         |
| `ctx.getToken()`           | Resolve the bearer token for a tool's declared `auth` (throws without `auth`) |
| `ctx.requireAuth()`        | Force the tool's authorization flow before proceeding                         |

## Imports at a glance

| Import                                                      | Holds                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `eve`                                                       | `defineAgent`, `defineRemoteAgent`, agent config types               |
| `eve/tools`                                                 | `defineTool`, `defineDynamic`, `disableTool`, `ExperimentalWorkflow` |
| `eve/tools/defaults`                                        | the built-in tools as plain values                                   |
| `eve/tools/approval`                                        | `always`, `once`, `never`                                            |
| `eve/connections`                                           | `defineMcpClientConnection`, `defineOpenAPIConnection`               |
| `eve/channels`                                              | `defineChannel`, route verbs                                         |
| `eve/channels/eve`                                          | `eveChannel`                                                         |
| `eve/channels/auth`                                         | `localDev`, `vercelOidc`, `placeholderAuth`                          |
| `eve/channels/{slack,discord,teams,telegram,twilio,github}` | platform channel factories                                           |
| `eve/hooks`                                                 | `defineHook`                                                         |
| `eve/schedules`                                             | `defineSchedule`                                                     |
| `eve/skills`                                                | `defineSkill`, `defineDynamic`                                       |
| `eve/instructions`                                          | `defineInstructions`, `defineDynamic`                                |
| `eve/context`                                               | `defineState`, session and state types                               |
| `eve/sandbox`                                               | `defineSandbox`, backends                                            |
| `eve/instrumentation`                                       | `defineInstrumentation`, `isChannel`                                 |
| `eve/evals`                                                 | `defineEval`, `defineEvalConfig`, eval types                         |
| `eve/evals/expect`                                          | `includes`, `equals`, `matches`, `similarity`                        |
| `eve/evals/reporters`                                       | `Braintrust`, `JUnit`, `EvalReporter`                                |
| `eve/evals/loaders`                                         | `loadJson`, `loadYaml`                                               |
| `eve/react`, `eve/vue`, `eve/svelte`                        | `useEveAgent`                                                        |
| `eve/next`, `eve/nuxt`, `eve/sveltekit`                     | framework bundler plugins                                            |
| [`eve/client`](../guides/client/overview)                   | `Client`, `ClientSession`                                            |

Exported types ship from the same entrypoint as the helper they describe (for example `ToolDefinition` and `ToolContext` from `eve/tools`). For the exhaustive list, read `packages/eve/src/public/index.ts`.

## What to read next

- [`agent.ts`](../agent-config): the agent config these helpers configure
- [Tools](../tools): `defineTool`, the most-used helper
- [Project layout](./project-layout): where each define\* lives on disk
