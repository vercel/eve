---
title: "TypeScript API Reference"
description: "The define* helpers, the runtime ctx, and where each one is imported from."
---

This is the public surface of the `eve` package: the `define*` helpers you author with, the `ctx` they receive at runtime, and the import path for each. The package's export map defines the full contract; source files that are not reachable through an exported package subpath are framework internals.

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

| Helper                                                | Import from                                                             | Authored at                                                                            | Guide                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `defineAgent`                                         | `eve`                                                                   | `agent/agent.ts`                                                                       | [agent.ts](../agent-config)                            |
| `defineTool`                                          | `eve/tools`                                                             | `agent/tools/<name>.ts`                                                                | [Tools](../tools)                                      |
| `defineDurableCallback`                               | `eve/tools`                                                             | provider-package dynamic tool factories                                                | [Dynamic capabilities](../guides/dynamic-capabilities) |
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
| `defineSandbox`                                       | `eve/sandbox`                                                           | `agent/sandbox.ts`                                                                     | [Sandbox](../sandbox)                                  |
| `defineInstrumentation`                               | `eve/instrumentation`                                                   | `agent/instrumentation.ts`                                                             | [instrumentation.ts](../guides/instrumentation)        |
| `defineRemoteAgent`                                   | `eve`                                                                   | `agent/subagents/<id>/agent.ts`                                                        | [Remote agents](../guides/remote-agents)               |
| `defineEval`                                          | `eve/evals`                                                             | `evals/*.eval.ts`                                                                      | [Evals](../evals/overview)                             |
| `defineEvalConfig`                                    | `eve/evals`                                                             | `evals/evals.config.ts`                                                                | [Evals](../evals/overview)                             |
| `mockModel`                                           | `eve/evals`                                                             | Deterministic fixture agent models                                                     | [Evals](../evals/overview)                             |
| `useEveAgent`                                         | `eve/react`, `eve/vue`, `eve/svelte`                                    | frontend                                                                               | [Frontend](../guides/frontend/overview)                |

Tool-wide authoring helpers and types such as `defineTool`, `defineWorkflowTool`, `defineDurableCallback`, `defineDynamic`, `disableTool`, and `ToolLabelDefinition` come from `eve/tools`. Capability-specific definitions and helpers use their own subpaths (see [Built-in tools](../concepts/built-in-tools)): reusable definitions such as `bash` and `glob` come from `eve/tools/<name>`, `webSearch` comes from `eve/tools/web_search`, `sleep` comes from `eve/tools/sleep`, and approval policies and types come from `eve/tools/approval`. The route verbs `GET`/`HEAD`/`POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS`/`WS` plus `disableRoute` come from `eve/channels`, and the channel auth helpers `localDev`/`vercelOidc`/`placeholderAuth` come from `eve/channels/auth`.

`AgentReasoningDefinition` is exported from `eve` for the top-level `defineAgent({ reasoning })` setting. `AgentLimitsDefinition` is exported for `defineAgent({ limits })`. `AgentDynamicWorkflowsDefinition` is exported for `defineAgent({ experimental: { dynamicWorkflows } })`; see [Dynamic workflows](../tools/dynamic-workflows). `AgentWorkflowDefinition`, `AgentWorkflowRetentionDefinition`, and `AgentWorkflowWorldDefinition` are exported separately for the Workflow SDK settings under `defineAgent({ experimental: { workflow } })`. `WebSearchToolInput` and `WebSearchProvider` are exported from `eve/tools/web_search`.

`defineInstructions` accepts `{ content: string, role?: "system" | "user" }`; omitted `role` means `"system"`. Its `eve/instructions` version of `defineDynamic` accepts only `session.started` and `turn.started` handlers returning `defineInstructions(...)` or `null`. The legacy `{ markdown: string }` definition remains available as a deprecated system-role form.

The `eve/connections` version of `defineDynamic` accepts `session.started` and
`turn.started` handlers returning one MCP or OpenAPI connection definition, a
map of connection definitions, or `null`. Its resolver context exposes
authenticated session identity and `channel.kind`, but not conversation history,
delivery payloads, tool inputs, model outputs, or free-form channel metadata. An
authenticated returned definition must set `instanceKey` to a stable,
non-secret account or tenant identifier so durable authorization resumes cannot
cross resolved instances.

## Authored module lifecycle

eve evaluates TypeScript definition modules during compilation so it can validate and normalize the agent. Within one agent node, each module namespace loads at most once during that compile. The resolved definition then determines whether the module is also an entry in the runtime bundle:

| Lifecycle           | Authored definitions                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compile only        | Static instructions and skills, prompt-form TypeScript schedules, static Gateway or default agent config, provider-managed web search, `experimental.workflow` Workflow SDK configuration, fully shadowed channels, and a child sandbox that selects its parent's sandbox |
| Compile and runtime | Dynamic instructions, skills, tools, models, and subagents; executable tools; effective channels; connections; hooks; memory; handler schedules; direct-provider models; independent sandboxes; and remote subagents                                                      |
| Runtime only        | Instrumentation modules and extension mount initialization                                                                                                                                                                                                                |

A compile-only module is not imported when the deployed runtime starts. For example, eve stores the resolved content from a static `instructions.ts` in the compiled manifest. A compile-and-runtime module is evaluated during compilation and imported again when a runtime process loads the module map. Keep module-top-level work deterministic, and put request- or session-specific work in the definition's runtime callbacks.

The runtime bundler follows the normal ESM graph from every runtime entry. A helper remains runtime code when a tool or other runtime entry imports it, even if static instructions also import that helper. Lifecycle selection applies to definition entries, not as tree-shaking permission for their ordinary dependencies.

### Asset imports

Authored modules may import relative non-code assets from anywhere inside their project package, including outside `agent/`:

```ts title="agent/tools/read_template.ts"
import icon from "../../assets/icon.png";
import template from "../../prompts/template.txt?raw";
```

`?raw` embeds the file as UTF-8 text. Other non-code asset imports produce a data URL with an inferred media type. Compilation, local development, and production builds use the same resolution behavior. Imports that escape the project package are rejected; package those files with the application instead.

## Runtime context (`ctx`)

`ctx` is passed to your tool `execute`, hook handlers, channel event handlers, and connection auth/header resolvers. It is live only while authored code is running, so reaching for it at module top level throws. See [Session context](../guides/session-context) for the full model.

| Member                      | Use                                                                          |
| --------------------------- | ---------------------------------------------------------------------------- |
| `ctx.session`               | Current session, turn, auth, and optional parent lineage (read-only)         |
| `ctx.getSandbox()`          | Live sandbox handle; `stop()` releases compute but preserves durable state   |
| `ctx.getSkill(identifier)`  | Handle for a named skill visible to the current agent                        |
| `ctx.getToken(provider)`    | Resolve a bearer token for an inline auth provider such as `connect("...")`  |
| `ctx.requireAuth(provider)` | Evict and re-authorize an inline provider, commonly after a downstream `401` |

## Imports at a glance

| Import                                                                      | Holds                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `eve`                                                                       | `defineAgent`, `defineRemoteAgent`, `defineDynamic`, agent config types                                 |
| `eve/tools`                                                                 | `defineTool`, `defineWorkflowTool`, `defineDurableCallback`, `defineDynamic`, `disableTool`, tool types |
| `eve/tools/{bash,read_file,write_file,todo,web_fetch,load_skill,glob,grep}` | Individual reusable tool definitions                                                                    |
| `eve/tools/approval`                                                        | Approval types and `always`, `once`, `never`                                                            |
| `eve/tools/web_search`                                                      | Provider-managed `webSearch` configuration                                                              |
| `eve/tools/sleep`                                                           | Opt-in durable `sleep` tool                                                                             |
| `eve/connections`                                                           | `defineMcpClientConnection`, `defineOpenAPIConnection`, `defineDynamic`                                 |
| `eve/channels`                                                              | `defineChannel`, `disableRoute`, route verbs                                                            |
| `eve/channels/eve`                                                          | `eveChannel`                                                                                            |
| `eve/channels/auth`                                                         | `localDev`, `vercelOidc`, `placeholderAuth`                                                             |
| `eve/channels/{slack,discord,teams,telegram,twilio,github}`                 | platform channel factories                                                                              |
| `eve/hooks`                                                                 | `defineHook`                                                                                            |
| `eve/schedules`                                                             | `defineSchedule`                                                                                        |
| `eve/skills`                                                                | `defineSkill`, `defineDynamic`                                                                          |
| `eve/instructions`                                                          | `defineInstructions`, `defineDynamic`                                                                   |
| `eve/memory`                                                                | `defineMemory`, `defineMemoryProvider`, provider and lifecycle types                                    |
| `eve/memory/scope`                                                          | `byPrincipal` and memory scope helpers                                                                  |
| `eve/memory/file`                                                           | `fileMemory`, `inMemory`, and the conditional document backend contract                                 |
| `eve/memory/file/vercel`                                                    | `vercelBlob` and Vercel Blob backend options                                                            |
| `eve/context`                                                               | `defineState`, session and state types                                                                  |
| `eve/sandbox`                                                               | `defineSandbox`, backends                                                                               |
| `eve/instrumentation`                                                       | `defineInstrumentation`, `isChannel`                                                                    |
| `eve/local-dev`                                                             | `getLocalDevCapability`, `LocalDevCapability`                                                           |
| `eve/models/openai`                                                         | `chatgpt`, deprecated `experimental_chatgpt`                                                            |
| `eve/evals`                                                                 | `defineEval`, `defineEvalConfig`, `mockModel`, eval types                                               |
| `eve/evals/expect`                                                          | `includes`, `equals`, `matches`, `similarity`                                                           |
| `eve/evals/reporters`                                                       | `Braintrust`, `JUnit`, `EvalReporter`                                                                   |
| `eve/evals/loaders`                                                         | `loadJson`, `loadYaml`                                                                                  |
| `eve/react`, `eve/vue`, `eve/svelte`                                        | `useEveAgent`                                                                                           |
| `eve/next`, `eve/nuxt`, `eve/sveltekit`                                     | framework bundler plugins                                                                               |
| [`eve/client`](../guides/client/overview)                                   | `Client`, `ClientSession`, health and agent-info schemas, response errors                               |

Exported types ship from the same entrypoint as the helper they describe (for example `ToolDefinition` and `ToolContext` from `eve/tools`). The `exports` field in `packages/eve/package.json` lists every public entrypoint.

## Local development capability

Use `getLocalDevCapability()` when an authored tool needs to modify the local application's source tree during an interactive development turn:

```ts
import { getLocalDevCapability } from "eve/local-dev";

const localDev = getLocalDevCapability();
if (localDev === undefined) {
  throw new Error("This tool is available only from a local eve dev client.");
}

await localDev.withSuspendedSource(async () => {
  // Write under localDev.appRoot here.
});
```

The function returns `LocalDevCapability | undefined`. It returns a capability only while authored code handles a request from a client on the same machine as the `eve dev` server. Deployed runtimes and clients attached over the network receive `undefined`, even when the target is another development server. A local TUI that attaches to an existing headless server receives the capability because availability follows each request rather than the process that started the server.

`appRoot` is the authored application directory containing `package.json` and `agent/`, not the temporary runtime snapshot. `interactiveClient` is `true` when the requesting local client is the dev TUI; check it before starting a flow that requires terminal interaction.

Run source mutations inside `withSuspendedSource()`. It acquires a unique watcher lease, waits for your asynchronous callback to settle, and then releases the lease. Concurrent or nested calls cannot resume each other early, and releasing the final lease rebuilds the runtime artifacts. The callback's return value is returned, and its error is rethrown after release. If suspension cannot be acquired, the callback does not run. If the host cannot confirm release after a retry, the method throws an actionable error; restart `eve dev` before making more source changes.

## ChatGPT subscription models

`chatgpt()` from `eve/models/openai` serves an OpenAI model through your local ChatGPT login and bills the ChatGPT subscription. With no argument, it selects `gpt-5.6-sol`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";
import { chatgpt } from "eve/models/openai";

export default defineAgent({
  model: chatgpt(),
});
```

Pass another bare OpenAI model slug to override the default. `experimental_chatgpt()` remains as a deprecated alias.

`chatgpt()` uses stateless requests (`store: false`). eve retains reasoning summaries and encrypted reasoning in session history and replays them after tool calls and on later turns. You do not need to configure `reasoning.encrypted_content` explicitly.

Sign in directly from eve; the Codex CLI is not required:

1. Run `eve dev`, open `/model`, and select **Provider** → **ChatGPT subscription**.
2. Complete sign-in in the browser. If the browser does not open, use the URL printed in the terminal.
3. Return to eve after the terminal confirms that your subscription is connected. Normal token expiry is refreshed automatically.

eve stores your refresh token and account details in your operating system's credential store through [just-secrets](https://github.com/vercel-labs/just-secrets): the login Keychain on macOS, Credential Manager on Windows, or Secret Service on Linux. Access tokens stay in process memory; a new eve process refreshes the saved session when it first needs a token. The login is separate from Codex and is never written to your project.

If you previously signed in through Codex or used eve's `~/.eve/auth/chatgpt.json` file, sign in once through eve after upgrading. eve removes the old plaintext file after successfully saving the new session. It does not fall back to file storage if the OS credential store is unavailable.

Linux, including WSL, requires `/usr/bin/secret-tool` (commonly provided by `libsecret-tools`), a session D-Bus, and an unlocked Secret Service keyring. On macOS, unlock your login keychain and allow credential access if prompted. On Windows, PowerShell and Credential Manager must be available in your user session. OS credential storage protects secrets at rest; it does not guarantee isolation from malicious processes running as your OS user.

Over SSH, or if localhost port 1455 is occupied, eve shows a device code instead. Open the displayed link in a browser and enter the code. Device sign-in requires enabling device code authorization in **ChatGPT Settings → Security**, or having a workspace admin enable it in workspace permissions. Sign-in times out after five minutes; press **Ctrl+C** to cancel sooner. Device sign-in still requires an available OS credential store; use an API-key model in headless environments without one.

ChatGPT subscription credentials are local user credentials. `eve deploy` blocks agents whose active model is `chatgpt()` because those credentials are not uploaded to a deployment. Use an environment branch with a deployable model, or switch to an AI Gateway model before deploying.

Troubleshooting:

- **`chatgpt-sub login`**: open `/model` and select **Provider** → **ChatGPT subscription** to sign in again. The running dev session picks up the new login.
- **`chatgpt-sub unavailable`**: follow the reported OS credential-store recovery steps, or check your network connection if token refresh failed. Retry from `/model`. If eve reports an invalid stored session, sign in again to replace it.
- **Model rejected by the backend**: model availability depends on the signed-in ChatGPT account. Pick another supported OpenAI model.
- **Device sign-in unavailable**: enable device code authorization in ChatGPT security settings, or sign in from a local terminal with port 1455 available.

## What to read next

- [`agent.ts`](../agent-config): the agent config these helpers configure
- [Tools](../tools): `defineTool`, the most-used helper
- [Project layout](../getting-started#project-layout): where each define\* lives on disk
