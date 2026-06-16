---
title: "agent.ts"
description: "The agent's runtime config: defineAgent, the model, and compaction."
---

An agent's `agent.ts` calls `defineAgent` (from `eve`) to set its runtime config.

## A good default

A typical config selects a model:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
```

The root `agent.ts` can be omitted when no runtime config is needed. In that case, Eve defaults
to `anthropic/claude-sonnet-4.6`. When `agent.ts` is present, `model` is required.

`model` can be a gateway model id string (which routes through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)) or a provider-authored `LanguageModel`, when you want to call the provider directly, bypassing the gateway and configuring the model in code:

```ts title="agent/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-opus-4.8"),
});
```

## Compaction

Compaction summarizes older turns as you approach the context window. It is on by default, so you only touch it to tune when it kicks in. Lower `thresholdPercent` to compact sooner:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  compaction: {
    thresholdPercent: 0.75, // default 0.9
  },
});
```

See [Default harness](./concepts/default-harness#compaction) for how the loop applies it.

## Other fields

`defineAgent` takes a few more fields. For every field and its type, see the [TypeScript API](./reference/typescript-api).

### `modelOptions`

Provider option overrides forwarded to the model call.

### `experimental`

Opt-in flags that can change or disappear in any release, so treat them as unstable. The main one is `codeMode`, which routes executable tools through a sandboxed code-execution wrapper.

### `outputSchema`

A structured return type for task-mode runs: a subagent, schedule, or remote job.

### `build`

Build packaging controls. `externalDependencies` keeps listed packages external while Eve compiles authored modules such as tools and channels, and traces those packages into the hosted output.

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
