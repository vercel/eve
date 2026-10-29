---
title: "Prepare for 1.0"
description: "Update session controls, authoring definitions, imports, public types, client errors, retry options, and terminal flags for the pre-1.0 API cleanup."
url: /guides/prepare-for-1-0
---

Use this checklist when upgrading an existing project to the coordinated pre-1.0 API cleanup release. These changes do not make the release 1.0; the [stability policy](../reference/typescript-api#stability-policy) still distinguishes stable and experimental APIs.

Upgrade eve in your agent server and apply the authored-file changes below so it builds. Deploy it before upgrading clients: new clients call the `/end` endpoint, which older servers do not serve. Then update frontend code and scripts.

## End a session or start a new conversation

Replace retirement methods named `reset()` with `end()` on client sessions, `SessionStore`, React/Vue/Svelte bindings, channel session handles, `ChannelSource` from `eve/channels`, and the Slack handler context (`ctx.end()`):

```diff
-await session.reset({ reason: "Conversation finished" });
+await session.end({ reason: "Conversation finished" });
```

`end()` resolves with a delivery receipt, like the other session controls. The stream still records the control as `source: { control: "reset" }` on `delivery.admitted` for compatibility with recorded history, so code that matches that value does not change.

The HTTP endpoint changes from `POST /eve/v1/session/:sessionId/reset` to `POST /eve/v1/session/:sessionId/end`. Upgraded servers still serve `POST …/reset` beside `/end`, so existing HTTP callers keep working, but move them to `/end`.

Ending permanently retires the session and leaves the handle on the retired ID. Do not use `end()` for a **New chat** button. Use `newSession()` when the frontend binding or store owns session creation. When you supply an external `session`, `newSession()` only clears local state and keeps that handle; create a new client session and bind a new store or component to it instead:

```ts
import { Client } from "eve/client";

const client = new Client({ baseUrl: "https://agent.example" });
const { session } = await client.sessions.create();
await session.send("Start a new conversation.");
```

Use `clear()` to clear model context in the same active session instead. See [Session controls](./client/overview#sessions) for the differences.

The remote-agent cleanup path and persisted session-history encodings remain compatible with older deployments. This does not let a new client call `/end` on an old server; upgrade the server first.

## Rename the compaction threshold

`compaction.threshold` is a fraction from `0` through `1`, not a percentage. Rename the authored field without changing its value:

```diff
 export default defineAgent({
-  compaction: { thresholdPercent: 0.7 },
+  compaction: { threshold: 0.7 },
 });
```

The old field fails validation with migration guidance. The default remains `0.9`. See [Compaction](../agent-config#compaction).

`limits.sessionUsage: false` is now accepted when you want to disable the token-usage limit, including an inherited limit. Omitting it keeps the normal default; no migration is required.

## Export defineAgent from agent.ts

Every local `agent.ts`, root or subagent, must export the value `defineAgent` returns. A plain object now fails the build with `Export defineAgent({...}) from "<path>".`:

```diff
-export default { model: "anthropic/claude-sonnet-5" };
+import { defineAgent } from "eve";
+
+export default defineAgent({ model: "anthropic/claude-sonnet-5" });
```

A dynamic subagent resolver that selects a local agent must also return `defineAgent({...})`, `defineRemoteAgent(...)`, or `null`.

`DynamicSentinel`, `DisabledToolSentinel`, and `DisabledRouteSentinel` are opaque and no longer expose `kind` or `evaluate`. Create them only with `defineDynamic()`, `disableTool()`, and `disableRoute()`; hand-written objects of the same shape are rejected.

## Wrap connection definitions

Every connection must use the helper for its protocol. A plain object is no longer assumed to be an MCP connection:

```diff
-export default { url: "https://issues.example/mcp" };
+import { defineMcpClientConnection } from "eve/connections";
+
+export default defineMcpClientConnection({ url: "https://issues.example/mcp" });
```

Use `defineOpenAPIConnection` for OpenAPI connections. Keep the helper inside the dynamic factory when authoring a dynamic connection. See [Connections](../connections).

## Move tool replacement grants to eve-channel auth

For Vercel OIDC configurations with `{ subject, allowToolStubs }` entries, rename the helper and move its import to `eve/channels/eve`. Keep the subject declarations unchanged:

```diff
-import { vercelOidc } from "eve/channels/auth";
+import { eveVercelOidc } from "eve/channels/eve";

-vercelOidc({
+eveVercelOidc({
   subjects: [{ subject: evalRunner, allowToolStubs: true }],
 });
```

`eveVercelOidc` uses the same verifier and automatically declares Bearer challenges. A matching subject entry with `allowToolStubs: true` grants permission only to verified service/runtime principals, not users. Plain strings and implicit current-project acceptance do not grant permission. Replace the original auth entry rather than adding the new helper after it: the first successful authenticator wins. See the [complete channel configuration](./auth-and-route-protection#tool-replacement-permission).

Generic `vercelOidc` from `eve/channels/auth` remains identity-only and accepts only subject strings. Identity-only configurations need no helper rename. For named grant-bearing options, use `EveVercelOidcOptions` from `eve/channels/eve` instead of `VercelOidcOptions`.

Custom eve-channel callbacks can still return `allowToolStubs`. Change grant-bearing `AuthFn` / `AuthResult` annotations to `EveAuthFn` / `EveAuthResult` from `eve/channels/eve`; identity-only callbacks keep their existing types. The grant remains request-local, not a persisted or forwarded session attribute. Session creation with stubs and stub verification require it; later messages and result reads retain ordinary channel auth and your application's session-access policy. See [Tool stubs](../evals/tool-stubs#permit-tool-replacement).

## Choose one sandbox layout

If both `agent/sandbox.ts` and `agent/sandbox/` exist, move the definition to `agent/sandbox/sandbox.ts`. The combination now fails discovery instead of silently ignoring the root definition.

A standalone `agent/sandbox.ts` remains supported. See [Sandbox layout](../sandbox#define-an-environment).

## Move experimental imports

Import workspace helpers from the experimental entry:

```diff
-import { defineWorkspaceAgent } from "eve";
+import { defineWorkspaceAgent } from "eve/experimental/workspace";
```

Move `WorkspaceAgentDefinition` and `WorkspaceAgentTransport` type imports to the same entry. The `agents/<name>/` workspace layout and `withEve` from `eve/vercel` stay stable; the helper's experimental status does not change them.

Move just-bash `customCommands` and `filesystem` under `experimental`, and import their types, such as `JustBashCommand` and `JustBashFilesystem`, from `eve/experimental/sandbox/just-bash`. `JustBashSandbox` itself, `autoInstall`, and `prepare` stay on `eve/sandbox/just-bash`:

```diff
 export const environment = JustBashSandbox.environment({
-  customCommands: [today],
+  experimental: { customCommands: [today] },
 });
```

The Discord Gateway relay moves and drops its prefix:

```diff
-import { experimental_runDiscordGatewayRelay } from "eve/channels/discord/gateway";
+import { runDiscordGatewayRelay } from "eve/experimental/channels/discord/gateway";
```

See [just-bash](../sandbox/just-bash) and [Discord](../channels/discord).

## Flatten reconnect options

Replace `streamReconnectPolicy` with `reconnect`, move open-retry fields directly into that object, and rename `retryableErrorStatuses`:

```diff
 const delivery = await session.send("Continue the review.", {
-  streamReconnectPolicy: {
-    streamOpenReconnectPolicy: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5000 },
-    retryableErrorStatuses: [429, 503],
+  reconnect: {
+    maxAttempts: 3,
+    baseDelayMs: 250,
+    maxDelayMs: 5000,
+    retryableStatuses: [429, 503],
   },
 });
```

To disable automatic reconnects:

```diff
-streamReconnectPolicy: { reconnect: false }
+reconnect: false
```

Use the exported `ReconnectOptions` type from `eve/client` instead of `StreamReconnectPolicy` or `StreamReconnectRetryPolicy`. The option also applies to client session and event readers. Defaults and cursor recovery are unchanged; following reads keep reconnecting, and server-side readers do not reconnect. See [Streaming](./client/streaming#reconnection).

## Update client error handling and saved state

Every error `eve/client` throws now extends `EveError` and carries a stable snake_case `code`. Import the error classes from `eve/client` and narrow with their static `is()` rather than `instanceof`, so errors from a separately bundled copy of eve still match:

```diff
-if (error instanceof SessionNotActiveError && error.code === "EVE_SESSION_NOT_ACTIVE") {
+if (SessionNotActiveError.is(error) && error.code === "session_not_active") {
   // Start a new session.
 }
```

`SessionNotActiveError.code` is `session_not_ready` (with `retryable: true`) while a session is still starting, otherwise `session_not_active`; `EVE_SESSION_NOT_ACTIVE` is gone. `ClientError.code` is now `http_error` instead of `undefined` when the response carried no code.

`session.snapshot()` now returns the full `ClientSessionState`, including the opaque `inbox` value, instead of only `sessionId` and `streamIndex`. Persist it as is and pass it back unchanged, for example with `client.sessions.attach(saved.sessionId, saved)`. See [Faster sends with `inbox`](./client/overview#faster-sends-with-inbox).

## Update Workflow imports

Import durable primitives from `eve/workflow`, and run/hook operations from `eve/workflow/api`:

```diff
-import { createHook, createWebhook, sleep, FatalError, RetryableError, getWorkflowMetadata } from "workflow";
-import { start, getRun, resumeHook } from "workflow/api";
+import { createHook, createWebhook, sleep, FatalError, RetryableError, getWorkflowMetadata } from "eve/workflow";
+import { start, getRun, resumeHook } from "eve/workflow/api";
```

Bare `workflow` and `workflow/*` imports in authored modules now fail the build. Only the exports listed above are public; other SDK subpaths, helpers, and options are not supported by these entries. The previously removed `agent` and `ask` helpers stay removed: importing them from `eve/workflow` fails with a pointer to `defineWorkflowTool()` from `eve/tools`.

Both entries declare eve-owned types instead of the SDK's:

- `getHookByToken` is removed. Pass a deterministic `token` to `createHook({ token })`, and resume the hook with `resumeHook(token, payload)`. `resumeHook` accepts only a token, not a hook record or an encryption-key override, and resolves to `void`.
- `start(workflow, args?)` takes a `"use workflow"` function, not a source string, and no options such as `deploymentId` or `world`; eve routes runs to the agent's own queue and deployment.
- `start` and `getRun` return a `WorkflowRun` with only `runId`, `status`, `returnValue`, and `cancel()`.

```diff
-const hook = await getHookByToken(token);
-await resumeHook(hook, payload);
+await resumeHook(token, payload);
```

Use `WorkflowHook`, `WorkflowWebhook`, and `WorkflowMetadata` from `eve/workflow`, and `WorkflowRun` and `WorkflowRunStatus` from `eve/workflow/api`, for explicit annotations. Call `eve/workflow/api` operations from routes or `"use step"` helpers, not replayed workflow bodies. Both entries use eve's bundled SDK; do not install another SDK to make these imports resolve.

You can remove `eve/workflow-modules` from tsconfig `types` and reference directives. Existing references remain resolvable through 1.x, but the entry no longer declares bare modules. See [Workflow imports](../tools/workflows#workflow-imports).

## Replace third-party types in eve signatures

eve's authoring and configuration types no longer expose AI SDK, zod, OpenTelemetry, or channel-adapter types; only the model helpers still return AI SDK models. Any AI SDK language model or OpenTelemetry processor still type-checks wherever eve accepts one, so most projects only change annotations:

- Agent `model` fields accept `EveLanguageModel` (exported from `eve` and `eve/models`); any AI SDK language model satisfies it. `anthropic()`, `openai()`, `chatgpt()`, and `mockModel()` still return AI SDK language models, so nothing changes where you pass them to AI SDK functions.
- `DecisionModel` instances must declare `specificationVersion: "v4"`.
- `TokenUsage`, the usage record `limits.sessionUsage` callbacks receive, is now exported from `eve` for annotations.
- `MemoryToolDefinition` is removed. Type memory provider tools as `MemoryToolSet`, a map of `defineTool()` values (`ToolDefinition` from `eve/tools`).
- Import `SpanProcessor`, `SpanExporter`, and `SpanProcessorOrName` from `eve/instrumentation/otel`, `LinqWebhookVerifier` from `eve/channels/linq`, and `PhotonIMessageWebhookVerifier` and `PhotonProjectCredentials` from `eve/channels/photon`.

## Keep custom data out of channel state bookkeeping

Built-in channel state types no longer include the default handlers' bookkeeping, such as Slack `taskCards` and `threadStatus`, Chat SDK streaming fields, `pendingSignIns`, posted prompt cards, `shownPromptId`, `undeliveredReplyErrorId`, and Discord's `interactionToken`, `initialResponseSent`, and `hasMessageAnchor` (read the interaction token from the Discord handle). `TelegramHitlState` is no longer exported. Addressing, identity, and audience fields are unchanged. Keep custom handler data in your own state keys instead of reading or writing these fields.

## Remove unsupported Slack card imports

Remove these exports from `eve/channels/slack` imports:

- `Modal*`, `TextInput*`, and `ExternalSelect*` builders and their associated types.
- `CardJSXElement` and `CardJSXProps`.
- `isCardElement` and `cardChildToFallbackText`.
- `ChatElement`, `ContainerProps`, and the builder props types: `ButtonProps`, `CardLinkProps`, `CardProps`, `DividerProps`, `FieldProps`, `ImageProps`, `LinkButtonProps`, `SelectOptionProps`, `SelectProps`, and `TextProps`.

Card builders no longer accept JSX-style props with `children`. Call their data forms instead:

```diff
-Actions({ children: [Button({ id: "approve", children: "Approve" })] });
+Actions([Button({ id: "approve", label: "Approve" })]);
```

Use `CardText` for labels and `cardToFallbackText` for whole cards. Use native Slack view data for custom modals; the removed builders did not have a supported eve delivery path. Built-in human-in-the-loop modals are unchanged.

Supported message cards remain available. An existing `initialMessage: { card }` continues to work; proactive messages can now also use `{ text }`, `{ markdown }`, or `{ blocks, text? }`. Optional files upload into the root message's thread. Retrying a proactive send can repeat both the root post and its uploads. See [Slack cards](../channels/slack#cards) and [proactive sends](../channels/slack#proactive-sessions).

## Replace undocumented helper imports

| Entry                 | Removed export              | Migration                                                                                                               |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `eve/tools`           | `isDisabledToolSentinel`    | Export `disableTool()` from a tool file; let the compiler handle the sentinel.                                          |
| `eve/channels`        | `isDisabledRouteSentinel`   | Export `disableRoute()` from a route file instead of inspecting the sentinel.                                           |
| `eve/instrumentation` | `isInstrumentationDisabled` | Export `disableInstrumentation()` instead of inspecting the sentinel.                                                   |
| `eve/client`          | `failureOf`                 | Use `failure(view, turnId)` from `eve/events`.                                                                          |
| `eve/channels`        | `answerFromText`            | Parse your channel's input and answer through its authorized session handle; see [Custom channels](../channels/custom). |
| `eve/channels/linear` | `defaultOnAgentSession`     | Omit the override to use the built-in callback, or provide your own `onAgentSession`.                                   |

## Rename terminal display flags

Update scripts that call `eve dev` or `eve remote connect`:

| Old flag            | New flag                 |
| ------------------- | ------------------------ |
| `--tools`           | `--show-tools`           |
| `--reasoning`       | `--show-reasoning`       |
| `--subagents`       | `--show-subagents`       |
| `--connection-auth` | `--show-connection-auth` |

Values are unchanged, and the old display names are not aliases. For example:

```bash
eve dev --show-reasoning full --show-tools auto-collapsed
```

Model-effort `--reasoning` on `eve init` and `eve set model` is unchanged. `--assistant-response-stats`, `--context-size`, and `--logs` are unchanged too. See the [CLI reference](../reference/cli).

## Check the resulting project

Run your project's typecheck and `eve build`, then check the workflows you use: create a conversation, send a message, end it, and start another. Restore a saved session state and send to it. Test any proactive Slack messages and durable workflow waits your project defines.

Review [run-data retention](../agent-config#run-data-retention) before depending on a completed transcript remaining readable. This cleanup does not change the retention default: outside development, the default trace policy for private and unknown-audience sessions requests deletion when the session ends. Backend support determines whether deletion occurs; the current override remains experimental.
