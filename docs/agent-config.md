---
title: "Agent Configuration"
description: "Configure an eve agent's model, reasoning effort, compaction, limits, and runtime behavior in agent.ts."
---

An agent's optional `agent.ts` calls `defineAgent` (from `eve`) to configure the model and other runtime behavior. The root agent's file lives at `agent/agent.ts`, or in the app root with a [flat layout](./reference/agent-files#flat-layout). Declared [subagents](./subagents) have their own `agent.ts` and accept the same configuration.

## Set the model

A typical config selects a model:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
});
```

For a static AI Gateway model ID, make the same change with
`eve set model anthropic/claude-opus-5.5` from the project root or
`/model anthropic/claude-opus-5.5` in the local dev TUI.

Omit the root `agent.ts` to use `openai/gpt-6-luna-fast` with `reasoning: "high"`. When `agent.ts` is present, `model` is required.

Every local `agent.ts`, root or subagent, must export the value `defineAgent` returns, and so must a dynamic subagent resolver that selects a local agent. The build rejects a plain object with `Export defineAgent({...}) from "<path>".`

A gateway model ID string routes through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). To call a provider directly and configure the model in code, pass a model instance. eve types it as `EveLanguageModel`, exported from `eve` and `eve/models`, and every AI SDK language model satisfies it.

With a static Gateway model, `agent.ts` needs no code at runtime. A dynamic model or a model instance keeps `agent.ts` loaded at runtime, because eve resolves it while the agent runs. See [Authored module lifecycle](./reference/typescript-api#authored-module-lifecycle).

Use eve's helpers for direct OpenAI or Anthropic access without installing another provider package:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

export default defineAgent({
  model: anthropic(), // claude-sonnet-5
});
```

`openai()` from `eve/models/openai` defaults to `gpt-6-luna-fast`. Both helpers accept an optional native provider model ID and read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. In local development they can also use credentials saved through `/login`; deployments need the API key in the server environment.

For a local ChatGPT subscription, use `chatgpt()` from `eve/models/openai` and sign in with `/login`. It defaults to `gpt-6-luna-fast` and can't run in a deployment.

`/login` can switch a static Gateway string to an eve helper and manage its import, and `/model` changes the selected model and settings immediately. Edit custom provider SDK calls and dynamic expressions by hand. For provider-specific configuration, install an AI SDK provider package and pass its language model.

Model use is subject to the terms, data-processing commitments, retention behavior, and available controls of the selected provider and routing path. Review the [AI Gateway model catalog](https://vercel.com/ai-gateway/models) for gateway-routed models, and review the provider's terms when you configure a direct model instance.

eve fills some provider options by default. A value you set at the same path
wins and is sent unchanged.

| Option                                                                                 | Calls                                           | Default value                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providerOptions.openai.safetyIdentifier`, `providerOptions.anthropic.metadata.userId` | OpenAI and Anthropic model and compaction calls | SHA-256 fingerprint of the turn's [`auth.current`](./guides/auth-and-route-protection#what-reaches-ctxsessionauth) authenticator, issuer, type, id, and subject. Unset when `auth.current` is `null`. |
| `providerOptions.gateway.sessionId`                                                    | AI Gateway calls                                | The Agent Runs `gen_ai.conversation.id`, shared by every turn, delegated subagent, and compaction call in the conversation.                                                                           |
| `providerOptions.openai.promptCacheKey`                                                | Direct OpenAI and `chatgpt()` calls             | SHA-256 hash of the session ID, unique per subagent session.                                                                                                                                          |

The safety identifier never contains the caller's raw identity fields or attributes. It
follows the current caller when a later turn changes users. AI Gateway hashes
session IDs longer than 256 characters.

The Gateway session ID groups the conversation's generations into one session in
the AI Gateway logs Sessions view. It also drives
[session affinity](https://vercel.com/docs/ai-gateway/models-and-providers/session-affinity).
With affinity, AI Gateway first tries the provider that served the previous
call, so that provider can read the prompt from its cache. Affinity chooses only among the
providers your routing allows, but it can move one ahead of your `order`. To keep
`order` exactly, set `sessionAffinity: false`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  modelOptions: {
    providerOptions: {
      gateway: { order: ["bedrock", "anthropic"], sessionAffinity: false },
    },
  },
});
```

### Use a local model

To test against a model on your own machine, use the AI SDK
[OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers).
It works with any local server that implements the OpenAI Chat Completions API,
such as Ollama, LM Studio, llama.cpp, or vLLM. With
[Ollama](https://docs.ollama.com/api/openai-compatibility):

```bash
pnpm add @ai-sdk/openai-compatible
ollama pull gpt-oss:20b
OLLAMA_CONTEXT_LENGTH=64000 ollama serve
```

```ts title="agent/agent.ts"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const ollama = createOpenAICompatible({
  name: "ollama",
  baseURL: "http://localhost:11434/v1",
  includeUsage: true, // report token usage while streaming
});

export default defineAgent({
  model: ollama("gpt-oss:20b"),
  modelContextWindowTokens: 64_000,
});
```

- **Context window.** AI Gateway has no metadata for local models, so set
  `modelContextWindowTokens` to the context length your server allocates, not
  the model's maximum. eve uses it to decide when to compact. Ollama allocates
  as little as 4K tokens by default; raise it to at least 64K for agents, as
  above.
- **Tool calling.** eve agents call tools on most turns, so pick a model with
  native tool-calling support. `gpt-oss:20b`, `qwen3`, and `gemma4` are good
  starting points on Ollama.
- **Usage.** `includeUsage: true` lets token usage reach eve's
  [session limits](#runtime-limits). Local models report no cost, so
  `costUsd` stays unset in a `sessionUsage` check.
- **Other servers.** Change `baseURL`, for example to
  `http://localhost:1234/v1` for LM Studio. Pass `apiKey` for a remote
  OpenAI-compatible server that requires one.

A deployment cannot reach a server on your machine, so use a Gateway or hosted
provider model when you deploy.

### Choose the model dynamically

To select a model from the incoming prompt with an AI SDK decision model, use
[`auto` from `eve/models`](./guides/decide).

`model` also accepts `defineDynamic(fn)` from `eve/models` or `eve`. The function returns the
model, and a dynamic model has no compiled default.

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

export default defineAgent({
  model: defineDynamic((ctx) =>
    ctx.session.auth.initiator?.attributes.plan === "enterprise"
      ? "anthropic/claude-opus-5.5"
      : "anthropic/claude-sonnet-5",
  ),
});
```

The function returns a Gateway model ID, a model instance such as an AI SDK language model, or a selection object. See
[Dynamic capabilities](./guides/dynamic-capabilities) for the context and memo rules.

- **When it changes.** eve runs the function before each ordinary model call. A memo keyed by
  `ctx.turn?.id ?? null` keeps a choice for the turn; `ctx.session.id` keeps it until a deployment
  change. Switching models can reduce prompt-cache reuse.
- **Failures stop the turn.** A thrown error or invalid selection fails the turn before the
  provider call. `null` is not a model. Missing credentials fail at request time.
- **Serialization.** Only memo results must be JSON. The function can return a live provider
  instance built from those results. `ctx.model` is unavailable during model selection.
- **Selection object.** `{ model, reasoning?, modelContextWindowTokens?, modelOptions? }`.
  Omit `modelContextWindowTokens` to read it from the AI Gateway model catalog that `eve build` or
  `eve dev` recorded, without a network request. A model that catalog doesn't list fails the turn. Set
  `modelContextWindowTokens` for an unlisted, custom, or newly published model, or rebuild. Dynamic agents cannot set sibling `modelContextWindowTokens` or
  `modelOptions` fields; return per-model values from the function.

The `session.started` runtime identity does not include a model ID for a dynamic agent. Each public
`model.started` event reports the concrete model selected for that model call.

## Reasoning effort

`reasoning` sets the model's reasoning effort through AI SDK's provider-agnostic
option. In an authored `agent.ts` with a static model, omit `reasoning` to use
the provider's default.

```ts title="agent/agent.ts"
export default defineAgent({
  model: "openai/gpt-5.5",
  reasoning: "high",
});
```

Supported values are `"provider-default"`, `"none"`, `"minimal"`, `"low"`,
`"medium"`, `"high"`, and `"xhigh"`. The selected model and provider determine
which levels are available and how they map to provider-native settings. Use
`modelOptions.providerOptions` for provider-specific reasoning controls.
A dynamic model selection can return `reasoning` to override the agent setting;
omit it to inherit the agent setting.

Run `eve set model --reasoning high` to update this field from the command line.

## Prompt caching

eve caches prompts automatically for AI Gateway models and for Anthropic models
it recognizes by provider or model id. On a directly called model, set
`modelOptions.promptCache` to use a 1-hour cache. It also marks an unrecognized
model as Anthropic, such as a Bedrock application inference profile:

```ts title="agent/agent.ts"
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { defineAgent } from "eve";

export default defineAgent({
  model: bedrock(process.env.BEDROCK_INFERENCE_PROFILE_ARN!),
  modelContextWindowTokens: 200_000,
  modelOptions: {
    promptCache: { anthropic: { ttl: "1h" } }, // or { anthropic: {} } for the default 5m
  },
});
```

Not every Claude model supports a 1-hour cache. eve rejects `promptCache` on
Gateway models; use `providerOptions.gateway.caching` instead.

## Compaction

Compaction summarizes older turns as the conversation approaches the context window, and is on by default. The token count includes the fixed checkpoint prompt, so compaction starts before the conversation alone reaches the threshold. Lower `compaction.threshold`, a fraction from `0` to `1`, to compact sooner:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: {
    threshold: 0.75, // default 0.9
  },
});
```

See [Default harness](./concepts/default-harness#compaction) for how the loop applies it.

## Runtime limits

`limits` sets eve's runtime caps. `sessionUsage` receives the session's usage
and returns `true` when the session must stop starting model calls:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  limits: {
    sessionUsage: ({ window }) =>
      window.inputTokens - window.cacheReadTokens >= 200_000 ||
      window.outputTokens >= 20_000 ||
      (window.costUsd ?? 0) >= 1.5,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
```

`sessionTimeoutMs` sets how long any session, including a delegated session,
may sit idle before eve completes it. Omit it for 30 days, or set it to `false`
to disable the timeout. The idle window starts when the session is created. It
restarts each time a turn ends, including turns that clear or compact the
context or are cancelled. A session never expires while a turn is open, such as while its
[tasks](./tools/tasks) work or it waits for a person to answer. Process restarts
don't change the window.

When the window elapses, eve emits `session.ended` with `outcome: "completed"`
and releases the channel addresses, such as a Slack thread, that route messages
to the session. The next message at that address starts a new session. To carry the earlier conversation over, pass it as
[prior history](./channels/eve#start-from-prior-history). A session with
[zero retention](#run-data-retention) loses its stored payloads when it ends.

`sessionUsage` gets two `TokenUsage` records, a type exported from `eve`. `total` is everything the session has
spent, and `window` is what it spent since the last approved continuation. Each
record has these fields:

| Field              | Meaning                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputTokens`      | All input, including cache reads and writes.                                                                                                       |
| `cacheReadTokens`  | History the provider replays from its prompt cache on every step. Subtract it from `inputTokens` to count only new input.                          |
| `cacheWriteTokens` | Input written to the prompt cache.                                                                                                                 |
| `outputTokens`     | Generated output.                                                                                                                                  |
| `costUsd`          | Model token cost in US dollars that AI Gateway reports with each step. Excludes tool and infrastructure spend. Unset when no step reported a cost. |

`window` is `total` minus the session's
[total](./concepts/sessions-runs-and-streaming#replies-and-narration) when its
own budget prompt was last accepted. Before the first approval, it equals
`total`. Accepting a budget prompt that a subagent passed up starts the
subagent's window, not the parent's. The window survives redeploys and
replays.

Omit `sessionUsage` to stop at `40_000_000` new input tokens per window:

```ts
({ window }) => window.inputTokens - window.cacheReadTokens >= 40_000_000;
```

`sessionUsage` can raise its threshold after each approval. This limit asks
at 20,000 new input tokens, then at 40,000, 80,000, and so on:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  limits: {
    sessionUsage: ({ total, window }) => {
      const used = total.inputTokens - total.cacheReadTokens;
      // Usage when the last continuation was approved; 0 before the first.
      const approvedAt = used - (window.inputTokens - window.cacheReadTokens);
      // Double past it, so each approval allows twice the usage before the next prompt.
      let next = 20_000;
      while (next <= approvedAt) next *= 2;
      return used >= next;
    },
  },
});
```

Set `sessionUsage: false`, or a callback that always returns `false`, to leave
sessions uncapped. eve calls a `sessionUsage` callback before each model call
once the window has usage. The model call that crosses a limit finishes, because
exact usage arrives after the call completes. Before the next model call, eve
pauses the turn (`turn.paused`) and sends a continuation prompt:

| Option       | Result                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Continue** | Starts a new window and resumes the same turn.                                                                                                                                 |
| **Stop**     | Cancels the turn (`turn.settled` with `outcome: "cancelled"`), not an error. The session stays resumable, but because it is still over budget, the next message prompts again. |

Declining a delegated child's prompt cancels the root turn and the whole
delegation tree, so the parent never receives an error result it could retry.

A message that answers neither option waits behind the open prompt. It starts
no second prompt or turn. After **Continue**, the paused turn receives it
(`delivery.consumed`).

If an earlier deployment showed the continuation prompt, that turn has already
ended. A message that answers neither option waits behind the prompt and emits
no event until **Continue**. **Continue** starts a new turn that receives the
waiting message once.

Some sessions can't request input from a human, such as markdown schedules and
delegated runs without input proxying. They skip the prompt and fail the next
model call with `SESSION_USAGE_LIMIT_REACHED`. Its details carry the `total` and
`window` usage the check saw.

Each subagent session checks its own usage against its own `sessionUsage`, or
the root agent's when it authors none. A dynamic subagent always uses the root
agent's. Remote agents run under their own deployment's limits.

A child's usage, including its own subagents', also counts in the parent's
usage. Approving a continuation starts a new window without erasing `total`.
The parent counts delegated usage at these points:

| Delegated work                                           | Counts against the parent                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Agent task                                               | With each reply. A turn with no reply, such as a cancelled one, counts with the next reply, or when the turn ends if no call waits. |
| `ctx.agent` session from any other `serve` workflow tool | The same way as an agent task.                                                                                                      |
| `ctx.agent` session from an `execute` or `task` tool     | When the tool finishes.                                                                                                             |
| Remote agent                                             | The same way as an agent task, cost included.                                                                                       |

Some delegated usage doesn't count against the parent:

- A `ctx.agent` turn still running when its workflow tool finishes or is cancelled.
- The `ctx.agent` usage of an `execute` tool whose parent turn is cancelled while it waits.
- What a cancelled agent task's own subagents spend after the task reports its cancelled turn.

A cancelled agent task ends and sends no further reply. Usage the cancelled run
reported up to that point still counts against the parent when its usage report
or final outcome arrives.

## Workflow world

The Workflow world is the backend that stores and runs sessions, so they survive restarts and redeploys. Omit
`experimental.workflow.world` to use Vercel Workflow on Vercel and the SDK's
local world in local development or `eve start`. Self-hosted deployments can
select a world package in the root `agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  experimental: {
    workflow: {
      world: "@workflow/world-postgres",
    },
  },
});
```

Install the package in your app; it must export a default factory or a
`createWorld()` function. Install a version built against the same
`@workflow/*` major version as your eve release, currently `5.x`:

```bash
pnpm add @workflow/world-postgres
```

eve fails at startup, naming the version to install, when the world targets a
different major version.

Put credentials, such as the Postgres connection string, and host-specific
options in the environment variables the world package reads, not in
`agent.ts`. If the package must stay external in hosted output, list it in
`build.externalDependencies`. See [Workflow worlds](./guides/deployment/workflow-worlds)
to choose a world and set up the Postgres world's database.

## Workflow checkpoint batching

eve saves a Workflow step after every model call and its inline tool calls. `experimental.workflow.modelCallsPerStep` lets one step run several
sequential model calls:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  experimental: {
    workflow: {
      modelCallsPerStep: 4,
    },
  },
});
```

The value is a positive-integer maximum. Omit it for `1`. It applies
separately to each root agent or declared subagent. A higher value can reduce
save overhead in sequential tool loops, but more work runs again after a crash.
If the step is interrupted, its earlier model calls and inline tool calls can
run again, repeating provider costs, events, and side effects. Use stable
idempotency keys for non-idempotent tools.

A batch ends before eve waits for input, authorization, or other blocking work.
It can end below the maximum when the turn completes or steering arrives. Before assistant output begins, steering can interrupt pending model
generation; running tools finish before the batch yields. This option is
experimental and may change or disappear in any release. See [Execution model
and durability](./concepts/execution-model-and-durability#resuming-after-a-crash)
for the retry behavior.

## Run data retention

Run-data retention is how long the Workflow World keeps a session's run data.
Omit `experimental.workflow.retention` to derive it from the session's resolved
[OpenTelemetry trace policy](./observability/otel#configure-opentelemetry) when
the session starts:

- When the policy allows both inputs and outputs, eve uses the World's default
  retention period.
- When the policy drops the trace or excludes either content direction, eve
  requests deletion when the run ends (Workflow's `experimental_retention: 0`).
  Workflow can't delete inputs and outputs separately.

Without a custom policy, public conversations and development sessions use the
World's default. Private and unknown-audience sessions outside development
request `0`, even with no OpenTelemetry destination installed. Destination
export filters and lifecycle-provider policies don't change the decision.

Set `experimental.workflow.retention` to `0` to always request deletion, or to
`"default"` to always keep run data for the World's default period. This
override is experimental and has no compatibility promise:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  experimental: {
    workflow: {
      retention: 0,
    },
  },
});
```

The resolved value applies to every run of the session, including runs after a
redeploy. Session timeout and [workflow tool](./tools/workflows) runs keep the
World's default.

Retention applies per agent. A [subagent](./subagents) with its own session uses
its own explicit value or derives retention from its resolved trace decision,
including any inherited content ceiling. `experimental.workflow.world` is root-only.

At `0`, supporting Worlds delete run and step inputs, outputs, and errors;
event payloads; and stream contents when the run reaches a terminal state. The
data remains available while the session is active. Run, step, and event records
remain for the World's default period. These records include IDs, timestamps,
statuses, step names, and attributes, which can contain content such as eve's
session title. Local traces, exported telemetry, and data stored by tools, channels, or
model providers are not deleted.

The Workflow World enforces deletion. A World older than spec version 4 rejects
`0`, and a spec version 4 World without retention support keeps the data.
Confirm support with your World provider. See
[Workflow data retention](https://workflow-sdk.dev/docs/observability/retention).

> ⚠️ **At `0`, completed session transcripts become unreadable.** Deletion races reads of finished runs. Depending on the World, reading deleted session history returns either an empty stream or `410` with `code: "session_expired"`. Persist anything you need to keep from inside a tool, or set `retention: "default"` to preserve completed-session reads independently of tracing.

## Other defineAgent fields

All other `defineAgent` fields are optional. For the exported types, see the [TypeScript API Reference](./reference/typescript-api).

| Field          | Type                                  | Default          | Description                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoning`    | `AgentReasoningDefinition`            | provider default | Provider-agnostic reasoning effort forwarded to the agent's turn model calls.                                                                                                                                                                                                                                       |
| `modelOptions` | `AgentModelOptionsDefinition`         | none             | Provider option overrides forwarded to the model call, and [`promptCache`](#prompt-caching) settings.                                                                                                                                                                                                               |
| `limits`       | `AgentLimitsDefinition`               | field-specific   | eve's [runtime limits](#runtime-limits).                                                                                                                                                                                                                                                                            |
| `experimental` | `AgentExperimentalDefinition`         | unset            | Unstable opt-ins: [`workflow.world`](#workflow-world), [`workflow.modelCallsPerStep`](#workflow-checkpoint-batching), and [`workflow.retention`](#run-data-retention).                                                                                                                                              |
| `build`        | `{ externalDependencies?: string[] }` | none             | Hosted-build packaging controls. `externalDependencies` keeps listed packages unbundled and includes them in the hosted output.                                                                                                                                                                                     |
| `tool`         | `boolean \| "deferred"`               | `true`           | Exposes this agent to its parent model as a tool. `"deferred"` hides it from the tool list until the model finds it with `eve__search` and calls it with `eve__tool`. On the root agent, controls the built-in `agent` tool. With `false`, authored workflow tools can still call a subagent through `ctx.agent()`. |

`externalDependencies` only controls packaging; it doesn't authorize, configure, or review any third-party service those packages call.

During `eve dev`, packages listed in `externalDependencies` use normal Node.js resolution instead of being bundled, so restart the dev server after replacing one.

## Where adjacent settings live

| Concern                       | Lives in                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Instructions prompt           | `agent/instructions.md`, [Instructions](./instructions)                          |
| Per-tool approval (HITL)      | `agent/tools/*.ts`, [Tools](./tools)                                             |
| Inbound auth & network policy | the channel layer, [Auth & route protection](./guides/auth-and-route-protection) |
| Sandbox / workspace           | `agent/sandbox/`, [Sandbox](./sandbox)                                           |
| Telemetry & debugging         | `agent/instrumentation/`, [Instrumentation](./observability/instrumentation)     |

## What to read next

- [Default harness](./concepts/default-harness) for compaction and model context, and [Built-in tools](./concepts/built-in-tools) for the framework-provided tool set
- [TypeScript API Reference](./reference/typescript-api) for every `defineAgent` field and type
- [Subagents](./subagents) for the `description` requirement and child-agent config
