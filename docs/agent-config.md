---
title: "Agents"
description: "Configure an eve agent's model, reasoning effort, compaction, limits, and runtime behavior in agent.ts."
---

An eve app has one root agent assembled from the files under `agent/`. Its optional `agent.ts` calls `defineAgent` (from `eve`) when you need to configure the model or other runtime behavior. Declared [subagents](./subagents) have their own `agent.ts` and capabilities; this page covers the configuration shared by root agents and subagents.

## Set the model

A typical config selects a model:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
```

For a static AI Gateway model ID, you can make the same source change from the
project root with `eve set --model anthropic/claude-opus-4.8` or from the local
dev TUI with `/model anthropic/claude-opus-4.8`.

The root `agent.ts` can be omitted when no runtime config is needed. eve then selects its default `agent.ts` source at the same slot, configured with `openai/gpt-5.6-luna-fast`; authoring the file replaces that source.
When `agent.ts` is present, `model` is required.

A config that selects a static Gateway model is compile-only. A config that contains a dynamic model or a direct-provider `LanguageModel` remains a runtime entry because eve must resolve that authored value while the agent runs. See [Authored module lifecycle](./reference/typescript-api#authored-module-lifecycle).

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

For every OpenAI or Anthropic model call, eve fills the provider's end-user
safety identifier from the active turn's
[`auth.current`](./guides/auth-and-route-protection#what-reaches-ctxsessionauth)
principal when you have not configured it. For OpenAI, the option is
`providerOptions.openai.safetyIdentifier`; for Anthropic, it is
`providerOptions.anthropic.metadata.userId`. The default value is a SHA-256
fingerprint of the principal's authenticator, issuer, type, id, and subject;
eve does not send the raw principal fields or attributes. The fingerprint
follows the current caller when a later turn changes users. An authored value
at either provider path takes precedence and is forwarded unchanged. When
`auth.current` is `null`, eve does not add an identifier. The same rules apply
to compaction calls.

### Choose the model dynamically

`model` also accepts `defineDynamic({ events })`. Each matching handler must
return the concrete model for its scope; a dynamic model has no compiled
default.

```ts title="agent/agent.ts"
import { defineAgent, defineDynamic } from "eve";

export default defineAgent({
  model: defineDynamic({
    events: {
      "session.started": (_event, ctx) => {
        if (ctx.session.auth.initiator?.attributes.plan === "enterprise") {
          return "anthropic/claude-opus-4.8";
        }

        return "anthropic/claude-sonnet-5";
      },
    },
  }),
});
```

Handlers receive the shared [dynamic resolver
context](./guides/dynamic-capabilities) (`ctx.session`, `ctx.channel`,
`ctx.messages`) and return a gateway model id, an AI SDK `LanguageModel`, a
selection object. Returning `null` or `undefined` fails the turn.

- **Scopes.** `session.started` (once per session), `turn.started` (once per
  turn), `step.started` (every model step). Precedence: step > turn >
  session. Prefer `session.started`: prompt caches are per model, so every
  switch re-ingests the conversation at uncached prices. If no active
  selection exists before model-dependent work begins, the turn fails.
- **Failures stop the turn.** A resolver that throws, returns no model, or
  returns an invalid selection fails before the provider call. A selected
  model without valid credentials fails at request time.
- **Serialization.** Session/turn selections must be model id strings; return
  live `LanguageModel` objects only from `step.started`.
- **Selection object.** `{ model, modelContextWindowTokens?, modelOptions? }`.
  When `modelContextWindowTokens` is omitted, eve resolves it from the AI
  Gateway catalog and caches successful metadata in durable session state for
  24 hours. Set it explicitly for an unlisted or custom model. Dynamic agents
  cannot set sibling `modelContextWindowTokens` or `modelOptions` fields;
  return per-model values from the handler.

The `session.started` runtime identity does not include a model id for a
dynamic agent. Each public `step.started` event reports the concrete `modelId`
selected for that model call.

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
Run `eve set --reasoning high` to update this field from the command line.

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

Use `limits` for framework-owned runtime caps. Session usage limits stop the
current durable session from starting another model call after accumulated
provider-reported tokens or model token cost reaches a configured limit:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 20_000,
    maxTokenCostUsdPerSession: 1.5,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
```

`sessionTimeoutMs` sets an absolute lifetime for every session, including
delegated sessions. It defaults to 30 days, starts at creation, and survives
restarts and redeployments. At the deadline, eve lets an active turn settle,
then emits `session.completed` and releases the continuation; the next
qualifying channel message starts fresh. Set it to `false` to disable the
timeout. Expiration does not delete stored session data.

Input tokens, output tokens, and model token cost are checked independently.
The model call that crosses a limit is allowed to finish because exact usage
arrives after the call completes. Before the next model call, eve pauses the
session and sends a deterministic continuation prompt with two options:
**Approve** grants a fresh window of each configured size, and **Stop**
cancels the in-flight turn through the standard cancellation path
(`turn.cancelled` → `session.waiting`) — a user decision, not an error. The session stays resumable; because it is
still over budget, the next message re-raises the prompt. Declining a
delegated child's prompt cancels the root turn, which cascades to the whole
delegation tree — the delegating parent never receives an error result it
could retry against a fresh quota share. A reply that answers neither option
is queued while the existing prompt stays pending; eve does not raise another
copy. The reply is processed once the budget is granted.

Sessions that cannot reach a human — task-mode runs such as schedules and
delegated runs without input proxying — skip the prompt and fail the next model
call with `SESSION_TOKEN_LIMIT_REACHED` for token budgets or
`SESSION_TOKEN_COST_LIMIT_REACHED` for model token cost. A delegated task with
no inherited quota also fails instead of raising a continuation prompt that
could only grant another zero-value window.

When `maxInputTokensPerSession` is omitted, root sessions apply a default
input budget of `40_000_000` provider-reported input tokens.
`maxOutputTokensPerSession` and `maxTokenCostUsdPerSession` are unset by
default. `maxTokenCostUsdPerSession` is a US-dollar limit on model token cost,
not tool or infrastructure spend. It uses the cost reported with each model
step; AI Gateway supplies this value, while model steps without reported cost
do not add to the limit. Set any usage limit to `false` to uncap that axis.

Delegated subagent sessions have no fixed default. Each child receives a
share of the delegating parent's remaining quota at dispatch time — the
remainder in the current budget window split evenly across the batch's local
subagent calls — and a completed child's usage counts against the parent's
quota. Token-cost budgets follow the same rules, including splitting the
remaining US-dollar budget across a batch and adding completed child cost back
to the parent. Approving a continuation opens a fresh parent window for later
child grants without erasing lifetime usage. An authored child limit applies
only when it is tighter than the parent's grant; an uncapped parent delegates
uncapped children.

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

`defineAgent` takes a few more fields, all optional. For the exported types, see the [TypeScript API Reference](./reference/typescript-api).

Set `experimental.codeMode` to `"eager"` or `"lazy"` to replace eligible
direct tools with one framework-managed `code_mode` tool. The model writes a
JavaScript program that calls `tools.<name>(input)`; `code_mode` runs it as a
durable workflow in which every nested call is its own step, so a crash
mid-program resumes at the pending call instead of re-running earlier ones.
Tools with an approval policy other than `never()`, authored workflow tools,
ordinary `execution: "background"` tools, and framework task controls stay
direct. Subagent tools enter the program and
return their result when called, the same way an authored workflow tool's
`agent()` does. `"eager"` inlines every claimed signature in the tool
description; `"lazy"` lists names and lets the program discover schemas with
`tools.search_tools` and `tools.describe_tools`.

Dynamic tools, including discovered connection tools, use the same eligibility
rules. `connection_search` stays direct so its discoveries reach the next model
step's catalog; eligible discovered tools then move behind `code_mode` in both
modes. When names overlap, step-scoped definitions override turn-scoped,
session-scoped, and static definitions, in that order. Each program keeps the
tool catalog and captured values from the model step that dispatched it.

If a nested tool requires authorization, eve displays its authorization
request and waits for the matching callback before retrying that call. Earlier
completed calls retain their results. Tool and subagent failures reject the
corresponding JavaScript call, so programs can use `try`/`catch` or
`Promise.allSettled`. Cancelling code mode stops the workflow.

| Field          | Type                                                              | Default          | Description                                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning`    | `AgentReasoningDefinition`                                        | provider default | Provider-agnostic reasoning effort forwarded to the agent's turn model calls.                                                                                                                            |
| `modelOptions` | `AgentModelOptionsDefinition`                                     | none             | Provider option overrides forwarded to the model call.                                                                                                                                                   |
| `limits`       | `AgentLimitsDefinition`                                           | field-specific   | Framework-owned runtime limits. Sessions complete after 30 days by default; usage-limit defaults and inheritance are described above. Set a limit to `false` to disable it.                              |
| `experimental` | `{ codeMode?: "eager" \| "lazy"; workflow?: { world?: string } }` | unset            | Opt-in settings that can change or disappear in any release. `codeMode` groups eligible tools behind a JavaScript program; `workflow.world` selects the Workflow world package on the root agent.        |
| `outputSchema` | Standard Schema or a JSON Schema object                           | none             | Structured return type for function-like invocations such as a subagent turn, schedule, or remote job. Ordinary interactive turns ignore it unless the client supplies a per-message schema.             |
| `build`        | `{ externalDependencies?: string[] }`                             | none             | Hosted-build packaging controls. `externalDependencies` keeps listed packages external while eve compiles authored modules such as tools and channels, and traces those packages into the hosted output. |

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

- [Default harness](./concepts/default-harness) for compaction and model context, and [Built-in tools](./concepts/built-in-tools) for the framework-provided tool set
- [TypeScript API Reference](./reference/typescript-api) for every `defineAgent` field and type
- [Subagents](./subagents) for the `description` requirement and child-agent config
