---
title: "Upgrade Agent Files"
description: "Update agent.ts, connections, tools, sandboxes, memory providers, imports, and Workflow tools for eve 1.0."
navTitle: "Agent Files"
---

Every project needs some of these changes. They cover `agent.ts`, connections, tools, sandboxes, memory providers, and the modules your agent imports. Most of them fail `eve build` or your typecheck with a message that names the fix, so work through the errors with this page open. Sections start with the changes most projects need.

This page is part of [Upgrade to 1.0](/docs/guides/upgrade).

## Export `defineAgent` from every `agent.ts`

Every local `agent.ts`, root or subagent, must export the value `defineAgent` returns. A dynamic subagent resolver that selects a local agent must also return `defineAgent({...})`, `defineRemoteAgent(...)`, or `null`.

```ts
export default { model: "anthropic/claude-sonnet-5" }; // [!code --]
import { defineAgent } from "eve"; // [!code ++]
export default defineAgent({ model: "anthropic/claude-sonnet-5" }); // [!code ++]
```

Create sentinels only with `defineDynamic()`, `disableTool()`, and `disableRoute()`. `DynamicSentinel`, `DisabledToolSentinel`, and `DisabledRouteSentinel` are opaque, and hand-written objects of the same shape are rejected.

## Wrap connections in their protocol helper

eve doesn't assume a plain exported object is an MCP connection. Wrap each connection in `defineMcpClientConnection` or `defineOpenAPIConnection`. For a dynamic connection, call the helper inside its factory. See [Connections](/docs/connections).

```ts
export default { url: "https://issues.example/mcp" }; // [!code --]
import { defineMcpClientConnection } from "eve/connections"; // [!code ++]
export default defineMcpClientConnection({ url: "https://issues.example/mcp" }); // [!code ++]
```

Replace connection auth's `credentialOwner` with `principalType: "app" | "user"`. With `getToken` alone, an omitted `principalType` means `"app"`; set `"user"` for per-user tokens. See [connection credential ownership](/docs/connections#choose-app-vs-user-auth).

## Rename `compaction.thresholdPercent`

Rename the field and keep its value. Despite its old name, the value was always a fraction from `0` through `1`, not a percentage, so `0.7` stays `0.7`. The default stays `0.9`. See [Compaction](/docs/agent-config#compaction).

```ts
export default defineAgent({
  compaction: { thresholdPercent: 0.7 }, // [!code --]
  compaction: { threshold: 0.7 }, // [!code ++]
});
```

To turn off the token-usage limit, including one inherited from a parent agent, set `limits.sessionUsage: false`.

## Update tool approvals and built-in tools

- Remove `approvalKey` and reads of `ApprovalContext.approvedTools`. When the decision depends on the tool's input, write an `approval` policy instead. `once()` remembers the latest approval or denial of each tool for the rest of the session. A custom policy that wraps `once()` must return its decision unchanged, or the remembered answer is neither reused nor recorded. See [Tool approvals](/docs/human-in-the-loop).
- Export the built-in tool definitions `askQuestion`, `noReply`, and `sleep` directly instead of calling `askQuestion()`, `noReply()`, or `sleep()`.
- `grep` lists matching files by default. Set `outputMode: "content"` when the caller needs the matching lines. See [Built-in tools](/docs/concepts/built-in-tools#grep).

## Choose one sandbox layout and install your tools

If both `agent/sandbox.ts` and `agent/sandbox/` exist, move the definition to `agent/sandbox/sandbox.ts`. A standalone `agent/sandbox.ts` still works. See [Sandbox layout](/docs/sandbox#define-an-environment).

eve's default sandbox image, which the Vercel and Docker sandboxes use, doesn't include pnpm or pip. If your agent needs them, install them in the sandbox `prepare` callback:

- For pnpm, run `npm install -g pnpm`.
- For pip, run `sudo apt-get install -y python3-venv` and use the pip inside a virtual environment. Ubuntu's system Python refuses `pip install`.

Expect the sandbox template to rebuild once after the upgrade. See [Docker sandbox](/docs/sandbox/docker).

## Move imports

| Before                                                                                   | After                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `defineWorkspaceAgent`, `WorkspaceAgentDefinition`, `WorkspaceAgentTransport` from `eve` | `eve/experimental/workspace`                                              |
| `experimental_runDiscordGatewayRelay` from `eve/channels/discord/gateway`                | `runDiscordGatewayRelay` from `eve/experimental/channels/discord/gateway` |
| `JustBashCommand`, `JustBashFilesystem` from `eve/sandbox/just-bash`                     | `eve/experimental/sandbox/just-bash`                                      |
| `eve/tools/agent-router`                                                                 | `eve/tools/agent_router`                                                  |
| `eve/computer-use` and its subpaths                                                      | `eve/extensions/computer-use` and the matching subpaths                   |
| `eve/self-modification`, `eve/self-modification/local`                                   | `eve/extensions/self-modification/local`                                  |
| `eve/self-modification/remote`                                                           | `eve/extensions/self-modification/remote`                                 |
| `Datadog` from `eve/evals`                                                               | `datadogReporter` from `eve/evals`                                        |
| `MessageResponse`, `MessageResult`                                                       | `Delivery`, `DeliveryResult` from `eve/sessions`                          |
| `StreamOptions`, `GetEventStreamOptions`                                                 | `SessionStreamOptions` from `eve/sessions`                                |
| `SpanProcessor`, `SpanExporter`, `SpanProcessorOrName` from OpenTelemetry                | `eve/instrumentation/otel`                                                |
| `eve/self-modification/config`, `eve/setup`, `eve/setup/scaffold`                        | No public replacement                                                     |

The `agents/<name>/` workspace layout and `withEve` from `eve/vercel` are stable. `JustBashSandbox`, `autoInstall`, and `prepare` stay on `eve/sandbox/just-bash`, but `customCommands` and `filesystem` move under `experimental`:

```ts
export const environment = JustBashSandbox.environment({
  customCommands: [today], // [!code --]
  experimental: { customCommands: [today] }, // [!code ++]
});
```

## Use eve's own types

eve's authoring and configuration types don't expose AI SDK, zod, OpenTelemetry, or channel-adapter types. Any AI SDK language model or OpenTelemetry processor still type-checks where eve accepts one, so most projects only change annotations:

- Annotate agent `model` fields with `EveLanguageModel` from `eve` or `eve/models`. `anthropic()`, `openai()`, `chatgpt()`, and `mockModel()` still return AI SDK language models.
- Declare `specificationVersion: "v4"` on `DecisionModel` instances. `decide()` takes `signal` instead of `abortSignal` and returns only `answers` and `usage`.
- Import `TokenUsage`, the record `limits.sessionUsage` callbacks receive, from `eve`.
- Import `LinqWebhookVerifier` from `eve/channels/linq`, and `PhotonIMessageWebhookVerifier` and `PhotonProjectCredentials` from `eve/channels/photon`.

## Use `defineDynamic` for dynamic capabilities

Define a dynamic model, tool, skill, subagent, or instruction as `defineDynamic(ctx => value)`, a function eve calls to resolve the value at runtime. Replace lifecycle event maps with that function.

- Replace `defineDurableCallback` and `defineDurableSchema` wrappers with ordinary functions and schemas.
- Cache results from external services with `ctx.memo(key, fn)`. The result must be JSON.
- A dynamic model, a dynamic subagent config, or a `ctx.agent(name, { model })` override reads its context window from the model catalog recorded at build time. For a model that catalog doesn't list, return `modelContextWindowTokens` or rebuild.

See [Dynamic capabilities](/docs/guides/dynamic-capabilities).

## Update memory providers

- eve recalls memory before each turn and gives it to the model outside the conversation history, so compaction never summarizes it. Remove memory `visibility` options.
- A memory provider can capture history before compaction rewrites it. If that capture fails, the compaction doesn't happen.
- Type memory provider tools as `MemoryToolSet`, a map of `defineTool()` values, instead of `MemoryToolDefinition`.

See [Memory providers](/docs/memory/custom-provider).

## Configure GitHub access in the git extension

If `git({ github })` gets GitHub tokens through Vercel Connect, its `github.authorize` callback is the only check on which repositories and commands the agent can use. Every `gh` call runs only when `authorize` returns `true`.

- Set `github.principalType`, which is required: `"app"` for GitHub App installation tokens, or `"user"` for the caller's own token.
- Remove `github.org` and enforce the same restriction in `authorize`, as in the example below.
- The `gh` tool takes an optional `repository` instead of `permissions`, and it runs any `gh` or `git` subcommand. If your policy depends on the command, check `argv` in `authorize`.

```ts title="agent/extensions/git.ts"
import git from "eve/extensions/git";

import { brokerGitHubLease } from "../lib/github";

export default git({
  github: {
    connector: "github/my-agent",
    broker: brokerGitHubLease,
    principalType: "app",
    authorize: ({ owner }) => owner.toLowerCase() === "acme",
  },
});
```

See [Control access with `authorize`](/docs/code-extension#control-access-with-authorize).

## Workflow imports

Workflow tools import the Workflow SDK through eve. Import durable primitives from `eve/workflow` and run and hook operations from `eve/workflow/api`. Bare `workflow` and `workflow/*` imports fail the build.

```ts
import { createHook, sleep, FatalError } from "workflow"; // [!code --]
import { createHook, sleep, FatalError } from "eve/workflow"; // [!code ++]
import { start, getRun, resumeHook } from "workflow/api"; // [!code --]
import { start, getRun, resumeHook } from "eve/workflow/api"; // [!code ++]
```

`eve/workflow` exports `createHook`, `createWebhook`, `sleep`, `FatalError`, `RetryableError`, and `getWorkflowMetadata`. `eve/workflow/api` exports `start`, `getRun`, and `resumeHook`. Other Workflow SDK subpaths, helpers, and options aren't available, and these exports use eve's own types:

- `getHookByToken` is removed. Pass a deterministic `token` to `createHook({ token })`, then resume the hook with `resumeHook(token, payload)`, which resolves to `void`.
- `start(workflow, args?)` takes a `"use workflow"` function, not a source string. It takes no options such as `deploymentId` or `world`, because eve runs the workflow on the agent's own queue and deployment.
- `start` and `getRun` return a `WorkflowRun` with only `runId`, `status`, `returnValue`, and `cancel()`.
- `agent` and `ask` aren't exported. Use `defineWorkflowTool()` from `eve/tools`, and call `ctx.agent(target, input)` or `ctx.ask(request)` in its executor.

```ts
const hook = await getHookByToken(token); // [!code --]
await resumeHook(hook, payload); // [!code --]
await resumeHook(token, payload); // [!code ++]
```

Annotate with `WorkflowHook`, `WorkflowWebhook`, and `WorkflowMetadata` from `eve/workflow`, and `WorkflowRun` and `WorkflowRunStatus` from `eve/workflow/api`. Call `eve/workflow/api` operations from routes or `"use step"` helpers, not from replayed workflow bodies. Don't install another Workflow SDK; both entries use eve's bundled copy. You can remove `eve/workflow-modules` from tsconfig `types` and reference directives. See [Workflow imports](/docs/tools/workflows#workflow-imports).

## Replace removed helpers

| Removed                                                | Use instead                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `isDisabledToolSentinel` from `eve/tools`              | Export `disableTool()` from a tool file.                                                                        |
| `isDisabledRouteSentinel` from `eve/channels`          | Export `disableRoute()` from a route file.                                                                      |
| `isInstrumentationDisabled` from `eve/instrumentation` | Export `disableInstrumentation()`.                                                                              |
| `failureOf` from `eve/client`                          | `failure(view, turnId)` from `eve/events`.                                                                      |
| `answerFromText` from `eve/channels`                   | Parse your channel's input and answer through its session handle; see [Custom channels](/docs/channels/custom). |
| `defaultOnAgentSession` from `eve/channels/linear`     | Omit `onAgentSession` to use the built-in callback.                                                             |
