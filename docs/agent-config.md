---
title: "agent.ts"
description: "Set the agent's runtime config in agent.ts with defineAgent, including the model and compaction."
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

`model` accepts a gateway model id string, which routes through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). To call a provider directly and configure the model in code, pass a provider-authored `LanguageModel`:

```ts title="agent/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-opus-4.8"),
});
```

Model use is subject to the terms, data-processing commitments, retention behavior, and available controls of the selected provider and routing path. Review the [AI Gateway model catalog](https://vercel.com/ai-gateway/models) for gateway-routed models, and review the provider's terms when you configure a direct `LanguageModel`.

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

## Other defineAgent fields

`defineAgent` takes a few more fields, all optional. For the exported types, see the [TypeScript API](./reference/typescript-api).

| Field          | Type                                    | Default     | Description                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelOptions` | `AgentModelOptionsDefinition`           | none        | Provider option overrides forwarded to the model call.                                                                                                                                                                                                   |
| `experimental` | `{ codeMode?: boolean }`                | flags unset | Opt-in flags that can change or disappear in any release. Treat them as unstable. `codeMode` routes executable tools through a sandboxed code-execution wrapper, where the model writes JavaScript that calls the tools inside the [sandbox](./sandbox). |
| `outputSchema` | Standard Schema or a JSON Schema object | none        | Structured return type for task-mode runs (a subagent, schedule, or remote job). Interactive conversation turns ignore it unless the client supplies a per-message schema.                                                                               |
| `build`        | `{ externalDependencies?: string[] }`   | none        | Hosted-build packaging controls. `externalDependencies` keeps listed packages external while eve compiles authored modules such as tools and channels, and traces those packages into the hosted output.                                                 |

`codeMode` is experimental and may change or be removed.

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
