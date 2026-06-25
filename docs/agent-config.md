---
title: "agent.ts"
description: "Set the agent's runtime config in agent.ts with defineAgent, including the model, reasoning effort, and compaction."
---

An agent's `agent.ts` calls `defineAgent` (from `eve`) to set its runtime config.

## Set the model

A typical config selects a model:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
```

The root `agent.ts` can be omitted when no runtime config is needed. In that case, eve defaults
to `anthropic/claude-sonnet-4.6`. When `agent.ts` is present, `model` is required.

`model` accepts a gateway model id string, which routes through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). To call a provider directly and configure the model in code, pass a provider-authored `LanguageModel`.

Provider-specific AI SDK packages are regular project dependencies. A fresh `eve init` app includes the core `ai` package, but it does not install every provider package. Install the provider package you import, then set that provider's API key:

```bash
npm install @ai-sdk/anthropic
```

```ts title="agent/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-opus-4-8"),
});
```

Direct provider model ids use the provider's native format. For Anthropic, the
version uses hyphens (`claude-opus-4-8`), while the Gateway id above uses a dot
(`anthropic/claude-opus-4.8`).

Model use is subject to the terms, data-processing commitments, retention behavior, and available controls of the selected provider and routing path. Review the [AI Gateway model catalog](https://vercel.com/ai-gateway/models) for gateway-routed models, and review the provider's terms when you configure a direct `LanguageModel`.

## Reasoning effort

Set `reasoning` to control the model's reasoning effort through AI SDK's
provider-agnostic option:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "openai/gpt-5.5",
  reasoning: "high",
});
```

Supported values are `"provider-default"`, `"none"`, `"minimal"`, `"low"`,
`"medium"`, `"high"`, and `"xhigh"`. The selected model and provider determine
which levels are available and how they map to provider-native settings. Use
`modelOptions.providerOptions` when you need provider-specific reasoning controls.

## Compaction

Compaction summarizes older turns as you approach the context window. It's on by default, so you only tune when it kicks in. Lower `thresholdPercent` to compact sooner:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  compaction: {
    thresholdPercent: 0.75, // default 0.9
  },
});
```

See [Default harness](./concepts/default-harness#compaction) for how the loop applies it.

## Workflow world

By default, eve selects the Workflow SDK world for the host: Vercel Workflow on
Vercel, and the SDK's local world in local development or `eve start`. Advanced
self-hosted deployments can select the Workflow world package to use from the
root `agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
});
```

Install that package in your app. It should export a default factory or
`createWorld()` function. Pin a version built against the same `@workflow/*`
line as your eve release (currently the `5.0.0-beta` line):

```bash
pnpm add @workflow/world-postgres@5.0.0-beta.x
```

The npm `latest` tag can lag behind that line, so an unpinned install may pull
an incompatible major that fails with `ZodError: invalid_union` at run replay.

Put credentials and host-specific options in runtime environment variables read
by the world package, not in `agent.ts`. For the Postgres world, that means
putting the connection string or credentials in the env vars it reads. If the
installed package must stay external in hosted output, list it in
`build.externalDependencies`.

## Other defineAgent fields

`defineAgent` takes a few more fields, all optional. For the exported types, see the [TypeScript API](./reference/typescript-api).

| Field          | Type                                    | Default          | Description                                                                                                                                                                                                   |
| -------------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning`    | `AgentReasoningDefinition`              | provider default | Provider-agnostic reasoning effort forwarded to the agent's turn model calls.                                                                                                                                 |
| `modelOptions` | `AgentModelOptionsDefinition`           | none             | Provider option overrides forwarded to the model call.                                                                                                                                                        |
| `experimental` | `{ workflow?: { world?: string } }`     | unset            | Opt-in settings that can change or disappear in any release. Treat them as unstable. `workflow.world` selects the Workflow world package backing session state, queues, hooks, and streams on the root agent. |
| `outputSchema` | Standard Schema or a JSON Schema object | none             | Structured return type for task-mode runs (a subagent, schedule, or remote job). Interactive conversation turns ignore it unless the client supplies a per-message schema.                                    |
| `build`        | `{ externalDependencies?: string[] }`   | none             | Hosted-build packaging controls. `externalDependencies` keeps listed packages external while eve compiles authored modules such as tools and channels, and traces those packages into the hosted output.      |

`externalDependencies` is a packaging control only. It keeps selected packages as runtime dependencies in the hosted output; it does not authorize, configure, or review any third-party service those packages may call.

## Where adjacent settings live

| Concern                       | Lives in                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Instructions prompt           | `agent/instructions.md`, [Instructions](./instructions)                          |
| Per-tool approval (HITL)      | `agent/tools/*.ts`, [Tools](./tools)                                             |
| Inbound auth & network policy | the channel layer, [Auth & route protection](./guides/auth-and-route-protection) |
| Sandbox / workspace           | `agent/sandbox/`, [Sandbox](./sandbox)                                           |
| Telemetry & debugging         | `agent/instrumentation.ts`, [Instrumentation](./guides/instrumentation)          |

## What to read next

- [Default harness](./concepts/default-harness) for the loop and built-in tools this config drives
- [TypeScript API](./reference/typescript-api) for every `defineAgent` field and type
- [Subagents](./subagents) for the `description` requirement and child-agent config
