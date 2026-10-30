---
title: "TypeScript API Reference"
description: "The define* helpers, the runtime ctx, and where each one is imported from."
---

The `eve` package's public surface is the `define*` helpers you author with, the `ctx` they receive at runtime, and the import path for each. The package's export map defines the full contract; anything not reachable through an exported subpath is internal.

For changes to an existing application, follow [Prepare for 1.0](../guides/prepare-for-1-0).

Identity comes from the filesystem, not a field you set. A tool at `agent/tools/get_weather.ts` is `get_weather`, and a connection at `agent/connections/linear.ts` is `linear`, so no definition carries a `name` or `id`.

Most files import a helper and default-export the result:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({ model: "anthropic/claude-opus-5.5" });
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

## Integration dependencies

Install the packages for each integration entry you import. They are optional peers of eve, so other entries don't need them.

| Entry                                                         | Required integration packages                         |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `eve/react`                                                   | `react` 19 (and its React typings in TypeScript apps) |
| `eve/vue`                                                     | `vue` 3.5 or later in v3                              |
| `eve/svelte`                                                  | `svelte` 5                                            |
| `eve/next`                                                    | `next` 16 and `react` 19                              |
| `eve/sveltekit`, `eve/tanstack`                               | `vite` 8.3.1 or later in v8                           |
| `eve/nuxt`                                                    | `@nuxt/kit` 4 and `@nuxt/schema` 4                    |
| Chat SDK, Linq, and Photon channels                           | `chat` 4.42 or later in v4                            |
| `eve/channels/linq`                                           | Also `@linqapp/sdk` 0.47.1 or later in v0.47          |
| `eve/sandbox/just-bash`, `eve/experimental/sandbox/just-bash` | `just-bash` 3.6 or later in v3                        |
| `@vercel/connect/eve` with eve connections                    | `@vercel/connect` 2.5.2 or later in v2                |

Connections with `experimental.events` require a static Connect auth provider with its events bridge.
SDK-backed handles use the SDK classes installed in your app, not copies bundled with eve.

The AI SDK is a required peer and has its own Zod peer requirement. To type the results of
`client.info()` and `client.health()`, import `AgentInfoResult`, its entry types (such as
`AgentInfoToolEntry`), and `HealthResult` from `eve/client`.

## The define\* helpers

| Helper                                                | Import from                                                             | Authored at                                                                            | Guide                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `defineAgent`                                         | `eve`                                                                   | `agent/agent.ts`                                                                       | [agent.ts](../agent-config)                            |
| `defineTool`                                          | `eve/tools`                                                             | `agent/tools/<name>.ts`                                                                | [Tools](../tools)                                      |
| `defineWorkflowTool`                                  | `eve/tools`                                                             | `agent/tools/<name>.ts`                                                                | [Workflow tools](../tools/workflows)                   |
| `defineDynamic`                                       | `eve`, `eve/tools`, `eve/skills`, `eve/instructions`, `eve/connections` | dynamic model or subagent `agent.ts`; `agent/{tools,skills,instructions,connections}/` | [Dynamic capabilities](../guides/dynamic-capabilities) |
| `defineMcpClientConnection`                           | `eve/connections`                                                       | `agent/connections/<name>.ts`                                                          | [MCP connections](../connections/mcp)                  |
| `defineOpenAPIConnection`                             | `eve/connections`                                                       | `agent/connections/<name>.ts`                                                          | [OpenAPI connections](../connections/openapi)          |
| `defineChannel`                                       | `eve/channels`                                                          | `agent/channels/<name>.ts`                                                             | [Custom channels](../channels/custom)                  |
| `eveChannel`, `slackChannel`, and the other platforms | `eve/channels/<platform>`                                               | `agent/channels/<platform>.ts`                                                         | [Channels](../channels/overview)                       |
| `defineSkill`                                         | `eve/skills`                                                            | `agent/skills/<name>.ts`                                                               | [Skills](../skills)                                    |
| `defineInstructions`                                  | `eve/instructions`                                                      | `agent/instructions.ts`                                                                | [Instructions](../instructions)                        |
| `defineMemory`, `defineMemoryProvider`                | `eve/memory`                                                            | `agent/memory.ts` or `agent/memory/<slot>.ts`                                          | [Memory](../memory)                                    |
| `defineHook`                                          | `eve/hooks`                                                             | `agent/hooks/<slug>.ts`                                                                | [Hooks](../guides/hooks)                               |
| `defineSchedule`                                      | `eve/schedules`                                                         | `agent/schedules/<name>.ts`                                                            | [Schedules](../schedules)                              |
| `defineState`                                         | `eve/context`                                                           | tools, hooks, lifecycle                                                                | [Session context](../guides/session-context)           |
| `defineSandbox`                                       | `eve/sandbox`                                                           | `agent/sandbox.ts` or `agent/sandbox/sandbox.ts`                                       | [Sandbox](../sandbox)                                  |
| `defineParentSandbox`                                 | `eve/sandbox`                                                           | `agent/subagents/<name>/sandbox.ts`                                                    | [Sandbox](../sandbox#share-a-parent-sandbox)           |
| `defineSandboxProvider`                               | `eve/sandbox/provider`                                                  | custom sandbox provider modules                                                        | [Custom providers](../sandbox/custom-providers)        |
| `defineInstrumentation`                               | `eve/instrumentation`                                                   | `agent/instrumentation/<name>.ts`                                                      | [Instrumentation](../observability/instrumentation)    |
| `otel`, `otelIntegration`                             | `eve/instrumentation/otel`                                              | `agent/instrumentation/<destination>.ts`                                               | [OpenTelemetry](../observability/otel)                 |
| `defineRemoteAgent`                                   | `eve`                                                                   | `agent/subagents/<id>/agent.ts`                                                        | [Remote agents](../guides/remote-agents)               |
| `defineEval`                                          | `eve/evals`                                                             | `evals/*.eval.ts`                                                                      | [Evals](../evals/overview)                             |
| `defineEvalConfig`                                    | `eve/evals`                                                             | `evals/evals.config.ts`                                                                | [Evals](../evals/overview)                             |
| `mockModel`                                           | `eve/evals`                                                             | Deterministic fixture agent models                                                     | [Evals](../evals/overview)                             |
| `useEveAgent`                                         | `eve/react`, `eve/vue`, `eve/svelte`                                    | frontend                                                                               | [Frontend](../guides/frontend/overview)                |

Tool-wide helpers and types such as `defineTool`, `defineWorkflowTool`, `defineDynamic`, `disableTool`, and `ToolLabelDefinition` come from `eve/tools`. Built-in tool definitions use their own subpaths; see [Built-in tools](../concepts/built-in-tools):

- Reusable definitions such as `bash` and `glob` from `eve/tools/<name>`.
- `webSearch` from `eve/tools/web_search`, `agentRouter` from `eve/tools/agent_router`, `sleep` from `eve/tools/sleep`, and `noReply` from `eve/tools/no_reply`.
- Approval policies and types from `eve/tools/approval`.

The route verbs `GET`/`HEAD`/`POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS`/`WS` and `disableRoute` come from `eve/channels`, and the channel auth helpers `localDev`/`vercelOidc`/`placeholderAuth` from `eve/channels/auth`.

`eve` exports `AgentReasoningDefinition` for `defineAgent({ reasoning })`, `AgentLimitsDefinition` for `defineAgent({ limits })`, and `AgentWorkflowDefinition`, `AgentWorkflowRetentionDefinition`, and `AgentWorkflowWorldDefinition` for `defineAgent({ experimental: { workflow } })`. `WebSearchToolInput` and `WebSearchProvider` are exported from `eve/tools/web_search`.

`webSearch({ provider })` selects `"exa"`, `"parallel"`, `"browserbase"`, or `"native"` for AI Gateway search with the Gateway model's credentials. `"native"` uses the model vendor's own search for OpenAI, Anthropic, and Gemini 3 and later models. Other Gateway models get no search unless you set `fallback` to `"exa"`, `"parallel"`, or `"browserbase"`. Direct provider models keep their native search implementation when supported. See [Built-in tools](../concepts/built-in-tools#web_search) for setup and provider behavior.

`defineInstructions` accepts `{ content: string, role?: "system" | "user" }`; omit `role` for `"system"`. Dynamic instructions use `defineDynamic(ctx => defineInstructions(...))` or return `null`.

Dynamic connections use `defineDynamic(ctx => value)`, returning one MCP or OpenAPI connection definition, a map, or `null`. Functions read the saved session context and can load conversation history with `ctx.messages()`. Set `instanceKey` to a stable, non-secret account or tenant identifier. eve rejects a pending sign-in callback when its resolved connection instance changes. See [Dynamic capabilities](../guides/dynamic-capabilities).

## Authored module lifecycle

eve evaluates TypeScript definition modules at build time to validate the agent, at most once per agent. The resolved definition decides whether the module also loads at runtime:

| When it loads       | Authored definitions                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compile only        | Static instructions and skills, prompt-form TypeScript schedules, static Gateway or default agent config, provider-managed web search, Workflow SDK configuration, fully shadowed channels, and a child sandbox that selects its parent's sandbox |
| Compile and runtime | Dynamic instructions, skills, tools, models, and subagents; executable tools; effective channels; connections; hooks; memory; handler schedules; direct-provider models; independent sandboxes; and remote subagents                              |
| Runtime only        | Instrumentation modules and extension mount initialization                                                                                                                                                                                        |

The deployed runtime doesn't import a compile-only module; for example, a static `instructions.ts` runs only at build time. A compile-and-runtime module runs at build time and again in each runtime process. Keep module top-level work deterministic, and put request- or session-specific work in runtime callbacks.

These load rules apply to definition modules, not their ordinary imports. A helper that a tool imports stays runtime code even if static instructions also import it.

### Asset imports

Authored modules may import relative non-code assets from anywhere inside their project package, including outside `agent/`:

```ts title="agent/tools/read_template.ts"
import icon from "../../assets/icon.png";
import template from "../../prompts/template.txt?raw";
```

`?raw` embeds any file as UTF-8 text, including code files such as `.json` and files without an extension, such as a `Dockerfile`. Other non-code asset imports produce a data URL with an inferred media type. Compilation, local development, and production builds use the same resolution behavior.

A workspace package bundled from TypeScript source can import its own assets the same way. Each import may reach files inside the project package or the importing module's package. eve rejects imports that escape both, so package those files with the application or the workspace package.

## Runtime context (`ctx`)

`ctx` is passed to your tool `execute`, hook handlers, channel event handlers, and connection auth/header resolvers. It exists only while authored code runs, so reading it at module top level throws. See [Session context](../guides/session-context) for the full model.

| Member                      | Use                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.session`               | Current session, turn, auth, and optional parent lineage (read-only)                                                                                                                                                                                   |
| `ctx.getSandbox()`          | Live sandbox handle; `stop()` releases compute and keeps the sandbox's files                                                                                                                                                                           |
| `ctx.getToken(provider)`    | Resolve a bearer token for an inline auth provider such as `connect("...")`                                                                                                                                                                            |
| `ctx.requireAuth(provider)` | Evict and re-authorize an inline provider, commonly after a downstream `401`                                                                                                                                                                           |
| `ctx.approval`              | Present only while a call runs after a person approved it: `responder` is who approved it and `responder.getToken(provider)` resolves their token. The call still runs as `ctx.session.auth.current`; see [Human-in-the-loop](/docs/human-in-the-loop) |

Tool definitions accept these options:

- `availableInSubagents: false` restricts the tool to top-level root sessions.
- `deferred: true` keeps the tool out of the model's tool list. The model finds it with `eve__search` and calls it with `eve__tool`; see [Tools](../tools#keep-a-tool-out-of-the-tool-list).

`defineTool` definitions accept `endsTurn: true`, or a function that receives the `execute` output, to end the turn without a reply after a successful call; see [Tools](../tools#end-the-turn-after-a-tool-call).

Authored workflow bodies also receive `ctx.agents`, a map that describes the agents the workflow can call. It stays the same across workflow replays. `ctx.agent(name)` returns an `AgentSession` whose `send(message, options?)` resolves to a response with `result()`. The `agent` entry is a copy of the root agent, and its description is empty when the root omits `description`. See [Workflows as tools](../tools/workflows#delegate-work-ctxagent) for the workflow-only context.

Type the context in a `"use step"` helper as `WorkflowStepToolContext`, which excludes `agents`, `agent`, and `ask`. Its `getSandbox()` opens the sandbox of the session that called the tool (see [Use the session sandbox in a step](../tools/workflows#use-the-session-sandbox-in-a-step)).

## Imports at a glance

| Import                                                                            | Holds                                                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `eve`                                                                             | `defineAgent`, `defineRemoteAgent`, `defineDynamic`, agent config types, `TokenUsage`                             |
| `eve/tools`                                                                       | `defineTool`, `defineWorkflowTool`, `defineDynamic`, `disableTool`, tool types                                    |
| `eve/tools/{bash,read_file,write_file,web_fetch,glob,grep}`                       | Individual reusable tool definitions                                                                              |
| `eve/tools/approval`                                                              | Approval types and `auto`, `always`, `once`, `never`                                                              |
| `eve/tools/ask_question`                                                          | Opt-in `askQuestion` tool definition                                                                              |
| `eve/tools/web_search`                                                            | Provider-managed `webSearch` configuration                                                                        |
| `eve/tools/workflow`                                                              | Runtime-generated `workflow` tool factory                                                                         |
| `eve/tools/sleep`                                                                 | Opt-in durable `sleep` tool                                                                                       |
| `eve/tools/no_reply`                                                              | Opt-in `noReply` tool definition                                                                                  |
| [`eve/workflow`](../tools/workflows#workflow-imports)                             | Durable `createHook`, `createWebhook`, `sleep`, `FatalError`, `RetryableError`, `getWorkflowMetadata`, hook types |
| [`eve/workflow/api`](../tools/workflows#workflow-imports)                         | `start`, `getRun`, `resumeHook`, `WorkflowRun`, and `WorkflowRunStatus` for routes and steps                      |
| `eve/connections`                                                                 | `defineMcpClientConnection`, `defineOpenAPIConnection`, `defineDynamic`                                           |
| `eve/channels`                                                                    | `defineChannel`, `disableRoute`, route verbs, `isChannel`, channel metadata types                                 |
| `eve/channels/eve`                                                                | `eveChannel`                                                                                                      |
| `eve/channels/auth`                                                               | `localDev`, `vercelOidc`, `placeholderAuth`                                                                       |
| `eve/channels/{slack,discord,teams,telegram,twilio,github}`                       | platform channel factories                                                                                        |
| `eve/hooks`                                                                       | `defineHook`                                                                                                      |
| `eve/schedules`                                                                   | `defineSchedule`                                                                                                  |
| `eve/skills`                                                                      | `defineSkill`, `defineDynamic`                                                                                    |
| `eve/instructions`                                                                | `defineInstructions`, `defineDynamic`                                                                             |
| `eve/memory`                                                                      | `defineMemory`, `defineMemoryProvider`, provider and lifecycle types                                              |
| `eve/memory/scope`                                                                | `byPrincipal` and memory scope helpers                                                                            |
| `eve/memory/file`                                                                 | `fileMemory`, `inMemory`, and the conditional document backend contract                                           |
| `eve/memory/file/vercel`                                                          | `vercelBlob` and Vercel Blob backend options                                                                      |
| `eve/context`                                                                     | `defineState`, session and state types                                                                            |
| `eve/sandbox`                                                                     | `defineSandbox`, `defineParentSandbox`, `DefaultSandbox`, and sandbox session and network policy types            |
| [`eve/sandbox/provider`](../sandbox/custom-providers)                             | `defineSandboxProvider`, provider errors, `SANDBOX_AGENT_ENV`, and connection and lifecycle types                 |
| [`eve/sandbox/docker`](../sandbox/docker)                                         | `DockerSandbox` and Docker environment and session types                                                          |
| [`eve/sandbox/vercel`](../sandbox/vercel)                                         | `VercelSandbox` and Vercel environment, session, and mount types                                                  |
| [`eve/sandbox/just-bash`](../sandbox/just-bash)                                   | `JustBashSandbox` and just-bash environment types                                                                 |
| `eve/instrumentation`                                                             | `defineInstrumentation`, `disableInstrumentation`, `InstrumentationEvent<K>`, lifecycle provider types            |
| `eve/instrumentation/otel`                                                        | `otel`, `otelIntegration`, `localTraces`, `agentRuns`, OpenTelemetry policy, span processor, and exporter types   |
| `eve/local-dev`                                                                   | `getLocalDevCapability`, `LocalDevCapability`                                                                     |
| [`eve/models`](../guides/decide)                                                  | Automatic model selection with `auto`, `EveLanguageModel`                                                         |
| `eve/models/openai`                                                               | `openai`, `chatgpt`                                                                                               |
| `eve/models/anthropic`                                                            | `anthropic`                                                                                                       |
| [`eve/ai`](../guides/decide#decide-inside-a-tool)                                 | Standalone `decide`                                                                                               |
| `eve/evals`                                                                       | `defineEval`, `defineEvalConfig`, `mockModel`, eval types                                                         |
| `eve/evals/expect`                                                                | `includes`, `equals`, `matches`, `similarity`                                                                     |
| `eve/evals/reporters`                                                             | `braintrustReporter`, `junitReporter`, `EvalReporter`                                                             |
| `eve/evals/loaders`                                                               | `loadJson`, `loadYaml`                                                                                            |
| `eve/react`, `eve/vue`, `eve/svelte`                                              | `useEveAgent`                                                                                                     |
| `eve/next`, `eve/nuxt`, `eve/sveltekit`, `eve/tanstack`                           | framework bundler plugins                                                                                         |
| [`eve/client`](../guides/client/overview)                                         | `Client`, `ClientSession`, health and agent-info schemas, `EveError` and the typed client errors                  |
| [`eve/sessions`](../guides/client/messages#reusable-delivery-reads)               | `Delivery`, `DeliveryResult`, read options, `SessionReader`, `Session`, `EveError`, and `SessionNotActiveError`   |
| [`eve/events`](../concepts/sessions-runs-and-streaming#query-session-state)       | Event types, opaque `SessionView`, immutable observations, and query/fold functions                               |
| [`eve/server`](../concepts/sessions-runs-and-streaming#read-a-session-in-process) | `sessions`, for reading session streams in process                                                                |

Exported types ship from the entry point that owns them, such as `ToolDefinition` and `ToolContext` from `eve/tools`. Import event and view types from `eve/events`, `SessionContext` and `HistoryMessage` from `eve/context`, and assertion types and `ToolStub` from `eve/evals`. Frontend hook entries also export the types their hooks return.

Types for reading sent messages and sessions live in `eve/sessions`; client factories and transport-specific types stay in `eve/client`. `SessionInfo` from `eve/context` is callback metadata, not a reader or an operable session. `ChannelContext` from `eve/channels` holds the session's `id` and `auth`, plus an optional `continuation` routing token that `alias()` can extend.

`HistoryMessage`, `EveLanguageModel`, `TokenUsage`, and the sandbox session, process, result, and method-option types are eve-owned. So are the `SpanProcessor`, `SpanProcessorOrName`, and `SpanExporter` types from `eve/instrumentation/otel`, and the Linq and Photon credential and webhook-verifier types. Their declarations don't change with your app's AI SDK, OpenTelemetry, or channel-adapter versions. Named judge, mock-model, approval, and disabled-marker types are public for reusable helpers and declaration emission.

## Stability policy

The `exports` field in eve's `package.json` lists every entry point. `eve/experimental/*` and `eve/internal/*` have no compatibility promise. Neither do `experimental` fields in stable definitions, such as `defineAgent({ experimental })`, connection `experimental.events`, and `JustBashSandbox.environment({ experimental })`. The CLI setup wizard is not a public authoring API.

Event union types name today's values. A release can add event types, outcomes, and request kinds under the [stream evolution rules](../concepts/sessions-runs-and-streaming#what-a-later-release-can-add) without a breaking change, so keep a default branch when you switch on them.

Values eve passes into code you implement can also gain members in a minor release. Examples are a sandbox provider's `onSessionEnd()` `reason`, the provider context's `kind`, and `SandboxNetworkRule` variants. Handle unknown values with a default branch instead of switching exhaustively.

`eve/channels/chat-sdk`, `eve/channels/linq`, and `eve/channels/photon` expose types from the `chat` package (Chat SDK v4) as part of their contract. A future breaking `chat` major can require a matching eve change.

## Direct provider models

`openai(model?)` from `eve/models/openai` and `anthropic(model?)` from `eve/models/anthropic` return AI SDK language models that use eve's credentials, so you can also pass them to AI SDK functions such as `generateText`. They accept only an optional model ID; omit it for `gpt-6-luna-fast` and `claude-sonnet-5`, respectively.

`EveLanguageModel`, exported from `eve` and `eve/models`, is the model type `agent.ts` accepts. Every AI SDK language model satisfies it.

Use `/login` for local credentials, or set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Local secret-store discovery is disabled in deployments; provision server credentials explicitly. See [Set the model](../agent-config#set-the-model) for an example.

## ChatGPT subscription models

`chatgpt()` from `eve/models/openai` serves an OpenAI model through your local ChatGPT login and bills the ChatGPT subscription. With no argument, it selects `gpt-6-luna-fast`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { chatgpt } from "eve/models/openai";

export default defineAgent({
  model: chatgpt(),
});
```

Pass another bare OpenAI model slug to override the default.

`chatgpt()` sends stateless requests (`store: false`). eve preserves reasoning across tool calls and later turns, so you don't configure `reasoning.encrypted_content`.

To sign in, use one local path. Who stores the credential depends on whether Codex is installed:

1. Run `eve dev`, open `/login`, and select **ChatGPT subscription**.
2. If `codex` is on `PATH`, eve uses `codex app-server` and launches `codex login` when sign-in is needed. Codex owns credential storage and refresh.
3. If the Codex binary is not found, eve falls back to direct browser sign-in and owns the saved session and refresh. If the browser does not open, use the URL printed in the terminal.

With Codex, eve asks app-server for tokens and doesn't read or write Codex login files. eve reports app-server errors other than a missing binary instead of switching credential owners.

The eve-owned fallback stores your refresh token and account details through [just-secrets](https://github.com/vercel-labs/just-secrets). It uses the login Keychain on macOS, Credential Manager on Windows, or Secret Service on Linux. Access tokens stay in process memory, and a new eve process refreshes the saved session when it first needs a token. The fallback login is separate from Codex and never written to your project. eve doesn't fall back to file storage when the OS credential store is unavailable.

Linux, including WSL, requires `/usr/bin/secret-tool` (commonly provided by `libsecret-tools`), a session D-Bus, and an unlocked Secret Service keyring. On macOS, unlock your login keychain and allow credential access if prompted. On Windows, PowerShell and Credential Manager must be available in your user session. OS credential storage protects secrets at rest, not from malicious processes running as your OS user.

The fallback uses a device code in SSH sessions or when localhost port 1455 is busy: open the displayed link and enter the code. Device sign-in requires device code authorization, enabled in **ChatGPT Settings → Security** or by a workspace admin in workspace permissions. Sign-in times out after five minutes; press **Ctrl+C** to cancel sooner. Device sign-in still needs an OS credential store; use an API-key model in headless environments without one.

`eve deploy` blocks agents whose active model is `chatgpt()`, because these local user credentials aren't uploaded to a deployment. Use an environment branch with a deployable model, or switch to an AI Gateway model before deploying.

Troubleshooting:

- **`chatgpt-sub login`**: open `/login` and select **ChatGPT subscription** to sign in again. eve launches `codex login` when Codex is available, or its direct sign-in flow when it is not.
- **`chatgpt-sub unavailable` with Codex installed**: update or restart Codex and retry.
- **`chatgpt-sub unavailable` without Codex**: follow the reported OS credential-store recovery steps, or check your network connection if token refresh failed. Retry from `/login`. If eve reports an invalid stored session, sign in again to replace it.
- **Model rejected by the backend**: model availability depends on the signed-in ChatGPT account. Pick another supported OpenAI model.
- **Device sign-in unavailable**: enable device code authorization in ChatGPT security settings, or sign in from a local terminal with port 1455 available.

## What to read next

- [`agent.ts`](../agent-config): the agent config these helpers configure
- [Tools](../tools): `defineTool`, the most-used helper
- [Agent Files](/docs/reference/agent-files): where each define\* lives on disk
