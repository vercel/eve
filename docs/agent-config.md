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
to `anthropic/claude-sonnet-5`. When `agent.ts` is present, `model` is required.

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

### Choose the model dynamically

`model` also accepts `defineDynamic({ fallback, events })`. `fallback` is the
compiled static model: it anchors build-time metadata (routing, credentials,
context window) and serves whenever no dynamic selection is set.

```ts title="agent/agent.ts"
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    fallback: "anthropic/claude-sonnet-5",
    events: {
      "session.started": (_event, ctx) =>
        ctx.session.auth.initiator?.attributes.plan === "enterprise"
          ? "anthropic/claude-opus-4.8"
          : null,
    },
  }),
});
```

Handlers receive the shared [dynamic resolver
context](./guides/dynamic-capabilities) (`ctx.session`, `ctx.channel`,
`ctx.messages`) and return a gateway model id, an AI SDK `LanguageModel`, a
selection object, or `null` to leave the scope unset.

- **Scopes.** `session.started` (once per session), `turn.started` (once per
  turn), `step.started` (every model step). Precedence: step > turn >
  session > `fallback`. Prefer `session.started`: prompt caches are per
  model, so every switch re-ingests the conversation at uncached prices.
- **Failures degrade, never fail the turn.** A resolver that throws or
  returns an invalid selection logs an error and leaves its scope unset.
  Build-time validation covers only `fallback`; a selected model without
  credentials fails at request time.
- **Serialization.** Session/turn selections must be model id strings; return
  live `LanguageModel` objects only from `step.started`.
- **Selection object.** `{ model, modelContextWindowTokens?, modelOptions? }`.
  Set `modelContextWindowTokens` when the selected model's window differs
  from the fallback's — it is never inherited. Omitted `modelOptions` reuses
  the agent-level `modelOptions`.

Runtime identity reports a dynamic agent's model as `dynamic:<fallback id>`.

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

Compaction summarizes older turns as you approach the context window. It's on by default, so you only tune when it kicks in. eve adds the estimated fixed checkpoint-prompt envelope to the trigger count, so compaction starts sooner than the conversation-only estimate. Lower `thresholdPercent` to compact sooner:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  compaction: {
    thresholdPercent: 0.75, // default 0.9
  },
});
```

See [Default harness](./concepts/default-harness#compaction) for how the loop applies it.

## Runtime limits

Use `limits` for framework-owned runtime caps. Session token limits stop the
current durable session from starting another model call after accumulated
provider-reported input or output token usage reaches the configured limit:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 20_000,
  },
});
```

Input and output budgets are checked independently. The model call that crosses
either limit is allowed to finish because providers only report exact token
usage after a call completes. Before the next model call, eve pauses the
session and sends a deterministic continuation prompt with two options:
**Continue** grants a fresh budget window of the configured size (both input
and output windows reset together), and **Stop** ends the session gracefully
(`session.completed`) — declining is a user decision, not an error. A reply
that answers neither option re-raises the prompt; the reply stays in history
and is processed once the budget is granted.

Sessions that cannot reach a human — task-mode runs such as schedules and
subagents without input proxying — skip the prompt and fail the next model
call with `SESSION_TOKEN_LIMIT_REACHED`.

When `maxInputTokensPerSession` is omitted, root sessions apply a default
input budget of `40_000_000` provider-reported input tokens.
`maxOutputTokensPerSession` is unset unless configured. Setting either limit
to `false` uncaps that axis — the session never stops on it.

Delegated subagent sessions have no fixed default. Each child receives a
share of the delegating parent's remaining quota at dispatch time — the
remainder (limit minus accumulated usage) split evenly across the batch's
local subagent calls — and a completed child's usage counts against the
parent's quota, so a delegation tree can never outspend the budget configured
at its root. An authored child limit applies only when it is tighter than the
parent's grant; an uncapped parent delegates uncapped children.

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
an incompatible protocol version that the Workflow SDK rejects during initialization.

Put credentials and host-specific options in runtime environment variables read
by the world package, not in `agent.ts`. For the Postgres world, that means
putting the connection string or credentials in the env vars it reads. If the
installed package must stay external in hosted output, list it in
`build.externalDependencies`.

## Other defineAgent fields

`defineAgent` takes a few more fields, all optional. For the exported types, see the [TypeScript API](./reference/typescript-api).

| Field          | Type                                    | Default          | Description                                                                                                                                                                                                                                                                |
| -------------- | --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning`    | `AgentReasoningDefinition`              | provider default | Provider-agnostic reasoning effort forwarded to the agent's turn model calls.                                                                                                                                                                                              |
| `modelOptions` | `AgentModelOptionsDefinition`           | none             | Provider option overrides forwarded to the model call.                                                                                                                                                                                                                     |
| `limits`       | `AgentLimitsDefinition`                 | field-specific   | Framework-owned runtime limits. `maxInputTokensPerSession` defaults to `40_000_000` for root sessions, and delegated subagent sessions inherit the parent's remaining quota; `maxOutputTokensPerSession` is unset unless configured; `false` uncaps a session token limit. |
| `experimental` | `{ workflow?: { world?: string } }`     | unset            | Opt-in settings that can change or disappear in any release. Treat them as unstable. `workflow.world` selects the Workflow world package backing session state, queues, hooks, and streams on the root agent.                                                              |
| `outputSchema` | Standard Schema or a JSON Schema object | none             | Structured return type for task-mode runs (a subagent, schedule, or remote job). Interactive conversation turns ignore it unless the client supplies a per-message schema.                                                                                                 |
| `build`        | `{ externalDependencies?: string[] }`   | none             | Hosted-build packaging controls. `externalDependencies` keeps listed packages external while eve compiles authored modules such as tools and channels, and traces those packages into the hosted output.                                                                   |

`externalDependencies` is a packaging control only. It keeps selected packages as runtime dependencies in the hosted output; it does not authorize, configure, or review any third-party service those packages may call.

During `eve dev`, ordinary dependencies are bundled into each retained runtime generation. Packages listed in `externalDependencies` keep normal Node.js resolution instead, so replacing one of those packages requires restarting the dev server.

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
