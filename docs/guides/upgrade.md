---
title: "Upgrade to 1.0"
description: "Move an eve project from 0.83 or earlier to 1.0: deploy order, the v27 session stream, renamed APIs, authoring changes, clients, channels, evals, and saved history."
---

This guide moves a project from eve 0.83 or earlier to 1.0. Most of the work is mechanical: renamed APIs, moved imports, and stricter definitions that `eve build` and your typechecker point out. Two areas need more care, because mistakes there compile cleanly:

- **Code that reads session events.** The session stream moves from format v26 to v27, and most event names change. A hook, dashboard, or stream reader that still matches v26 names builds without errors and then matches nothing.
- **Session history your application stores.** Events saved before the upgrade are in v26 format. Re-read or convert them before you load them into a v27 client.

After the upgrade, the [stability policy](../reference/typescript-api#stability-policy) tells you which APIs are stable and which are experimental.

## Upgrade in this order

1. **Rebuild your extensions.** eve refuses to load extensions built with 0.83 or earlier. Rebuild and republish the extensions you maintain, and upgrade third-party extensions to releases built for 1.0.
2. **Fix the agent build.** Upgrade `eve` in the agent server, then work through [Agent files](#agent-files) until `eve build` and your typecheck pass.
3. **Update event consumers.** Move hooks, channel handlers, instrumentation, and stream readers to [v27 events](#session-events) before you deploy, so they don't silently stop firing.
4. **Deploy the server.** Keep the old deployments running, because existing sessions finish their current work there; see [Existing sessions](#existing-sessions).
5. **Upgrade callers of remote agents first**, then the remote agents they call; see [Remote agents](#remote-agents).
6. **Upgrade clients and frontends** once the new server is live. New clients call routes, such as `/end`, that older servers don't serve; see [Clients and frontends](#clients-and-frontends).
7. **Migrate saved history** if your application stores session events; see [Saved session history](#saved-session-history).
8. **Check the result** with [Verify the upgrade](#verify-the-upgrade).

## Find what affects you

| If your project has…                                                 | Read                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `agent.ts`, connections, tools, a sandbox, or memory                 | [Agent files](#agent-files)                                             |
| Hooks, channel `events` handlers, instrumentation, or stream readers | [Session events](#session-events)                                       |
| Approvals, questions, or sign-ins                                    | [Approvals, questions, and sign-ins](#approvals-questions-and-sign-ins) |
| `eve/client`, `useEveAgent`, or `SessionStore` code                  | [Clients and frontends](#clients-and-frontends)                         |
| Slack, Teams, Telegram, Discord, Chat SDK, MCP, or custom channels   | [Channels](#channels)                                                   |
| Imports from `workflow` or `workflow/api`                            | [Workflow imports](#workflow-imports)                                   |
| Remote agents                                                        | [Remote agents](#remote-agents)                                         |
| Evals                                                                | [Evals](#evals)                                                         |
| Scripts that call the `eve` CLI                                      | [CLI](#cli)                                                             |
| Stored session events or message caches                              | [Saved session history](#saved-session-history)                         |
| Your own reducers, stream followers, or lifecycle state              | [Apps that track session state](#apps-that-track-session-state)         |

## Existing sessions

Sessions that started on eve 0.69 through 0.83 move to the new deployment on their own. An idle session moves the next time it receives a message, or earlier when a channel prepares it for one. Until then, it stays on the deployment that started it, so keep that deployment running.

Two kinds of session stay on the old deployment:

- A session with a background task, including an idle resumable one, stays until the task finishes.
- A session that started on a release before 0.69 never moves.

When a session moves, eve compacts its earlier conversation. The model continues from a summary, and the stored transcript stays intact. Remembered tool approvals and usage limits start over, so people may be asked to approve a tool again.

On worlds without deployment routing, follow the [stranded-session recovery guidance](../concepts/execution-model-and-durability#stranded-sessions).

## Agent files

`eve build` reports most of these changes with a message that names the fix.

### Export `defineAgent` from every `agent.ts`

Every local `agent.ts`, root or subagent, must export the value `defineAgent` returns. A dynamic subagent resolver that selects a local agent must also return `defineAgent({...})`, `defineRemoteAgent(...)`, or `null`.

```diff
-export default { model: "anthropic/claude-sonnet-5" };
+import { defineAgent } from "eve";
+
+export default defineAgent({ model: "anthropic/claude-sonnet-5" });
```

Create sentinels only with `defineDynamic()`, `disableTool()`, and `disableRoute()`. `DynamicSentinel`, `DisabledToolSentinel`, and `DisabledRouteSentinel` are opaque, and hand-written objects of the same shape are rejected.

### Rename `compaction.thresholdPercent`

Rename the field and keep its value. Despite its old name, the value was always a fraction from `0` through `1`, not a percentage, so `0.7` stays `0.7`. The default stays `0.9`. See [Compaction](../agent-config#compaction).

```diff
 export default defineAgent({
-  compaction: { thresholdPercent: 0.7 },
+  compaction: { threshold: 0.7 },
 });
```

To turn off the token-usage limit, including one inherited from a parent agent, set `limits.sessionUsage: false`.

### Wrap connections in their protocol helper

eve doesn't assume a plain exported object is an MCP connection. Wrap each connection in `defineMcpClientConnection` or `defineOpenAPIConnection`. For a dynamic connection, call the helper inside its factory. See [Connections](../connections).

```diff
-export default { url: "https://issues.example/mcp" };
+import { defineMcpClientConnection } from "eve/connections";
+
+export default defineMcpClientConnection({ url: "https://issues.example/mcp" });
```

Replace connection auth's `credentialOwner` with `principalType: "app" | "user"`. With `getToken` alone, an omitted `principalType` means `"app"`; set `"user"` for per-user tokens. See [connection credential ownership](../connections#choose-app-vs-user-auth).

### Use `defineDynamic` for dynamic capabilities

Define a dynamic model, tool, skill, subagent, or instruction as `defineDynamic(ctx => value)`, a function eve calls to resolve the value at runtime. Replace lifecycle event maps with that function.

- Replace `defineDurableCallback` and `defineDurableSchema` wrappers with ordinary functions and schemas.
- Cache results from external services with `ctx.memo(key, fn)`. The result must be JSON.
- A dynamic model, a dynamic subagent config, or a `ctx.agent(name, { model })` override reads its context window from the model catalog recorded at build time. For a model that catalog doesn't list, return `modelContextWindowTokens` or rebuild.

See [Dynamic capabilities](./dynamic-capabilities).

### Update tool approvals and built-in tools

- Remove `approvalKey` and reads of `ApprovalContext.approvedTools`. When the decision depends on the tool's input, write an `approval` policy instead. `once()` remembers the latest approval or denial of each tool for the rest of the session. A custom policy that wraps `once()` must return its decision unchanged, or the remembered answer is neither reused nor recorded. See [Tool approvals](/docs/human-in-the-loop).
- Export the built-in tool definitions `askQuestion`, `noReply`, and `sleep` directly instead of calling `askQuestion()`, `noReply()`, or `sleep()`.
- `grep` lists matching files by default. Set `outputMode: "content"` when the caller needs the matching lines. See [Built-in tools](../concepts/built-in-tools#grep).

### Choose one sandbox layout and install your tools

If both `agent/sandbox.ts` and `agent/sandbox/` exist, move the definition to `agent/sandbox/sandbox.ts`. A standalone `agent/sandbox.ts` still works. See [Sandbox layout](../sandbox#define-an-environment).

eve's default sandbox image, which the Vercel and Docker sandboxes use, doesn't include pnpm or pip. If your agent needs them, install them in the sandbox `prepare` callback:

- For pnpm, run `npm install -g pnpm`.
- For pip, run `sudo apt-get install -y python3-venv` and use the pip inside a virtual environment. Ubuntu's system Python refuses `pip install`.

Expect the sandbox template to rebuild once after the upgrade. See [Docker sandbox](../sandbox/docker).

### Update memory providers

- eve recalls memory before each turn and gives it to the model outside the conversation history, so compaction never summarizes it. Remove memory `visibility` options.
- A memory provider can capture history before compaction rewrites it. If that capture fails, the compaction doesn't happen.
- Type memory provider tools as `MemoryToolSet`, a map of `defineTool()` values, instead of `MemoryToolDefinition`.

See [Memory providers](../memory/custom-provider).

### Configure GitHub access in the git extension

If `git({ github })` gets GitHub tokens through Vercel Connect, its `github.authorize` callback is the only check on which repositories and commands the agent can use. Every `gh` call runs only when `authorize` returns `true`.

- Set `github.principalType`, which is required: `"app"` for GitHub App installation tokens, or `"user"` for the caller's own token.
- Remove `github.org` and enforce the same restriction in `authorize`, as in the example below.
- The `gh` tool takes an optional `repository` instead of `permissions`, and it runs any `gh` or `git` subcommand. If your policy depends on the command, check `argv` in `authorize`.

See [Control access with `authorize`](../code-extension#control-access-with-authorize).

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

### Move imports

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

```diff
 export const environment = JustBashSandbox.environment({
-  customCommands: [today],
+  experimental: { customCommands: [today] },
 });
```

### Use eve's own types

eve's authoring and configuration types don't expose AI SDK, zod, OpenTelemetry, or channel-adapter types. Any AI SDK language model or OpenTelemetry processor still type-checks where eve accepts one, so most projects only change annotations:

- Annotate agent `model` fields with `EveLanguageModel` from `eve` or `eve/models`. `anthropic()`, `openai()`, `chatgpt()`, and `mockModel()` still return AI SDK language models.
- Declare `specificationVersion: "v4"` on `DecisionModel` instances. `decide()` takes `signal` instead of `abortSignal` and returns only `answers` and `usage`.
- Import `TokenUsage`, the record `limits.sessionUsage` callbacks receive, from `eve`.
- Import `LinqWebhookVerifier` from `eve/channels/linq`, and `PhotonIMessageWebhookVerifier` and `PhotonProjectCredentials` from `eve/channels/photon`.

### Replace removed helpers

| Removed                                                | Use instead                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `isDisabledToolSentinel` from `eve/tools`              | Export `disableTool()` from a tool file.                                                                     |
| `isDisabledRouteSentinel` from `eve/channels`          | Export `disableRoute()` from a route file.                                                                   |
| `isInstrumentationDisabled` from `eve/instrumentation` | Export `disableInstrumentation()`.                                                                           |
| `failureOf` from `eve/client`                          | `failure(view, turnId)` from `eve/events`.                                                                   |
| `answerFromText` from `eve/channels`                   | Parse your channel's input and answer through its session handle; see [Custom channels](../channels/custom). |
| `defaultOnAgentSession` from `eve/channels/linear`     | Omit `onAgentSession` to use the built-in callback.                                                          |

## Session events

Session streams use stream version 27 (`x-eve-stream-version: 27`). The new deployment serves every stream in this format, including sessions that started on 0.83 or earlier, so update every piece of code that reads events. That includes hooks, channel handlers, instrumentation providers, evals, frontends, and scripts that read the NDJSON stream directly.

The stream is still newline-delimited JSON, but its structure changed:

- **A stored line holds a group of events.** One state change writes one line with all the events it produced, so a turn ending and the message it answered arrive together. Streamed text and tool-input deltas arrive separately, as progress records that are never part of a line.
- **Positions replace event IDs.** Each event carries `meta.position`: the zero-based `line` it was stored in and its `index` within that line. `startIndex` and saved cursors count lines, not events. Store events keyed on `(sessionId, line, index)`, so reading a stream again doesn't create duplicates.
- **Each event names what it belongs to.** An event's `scope` holds the IDs of its turn, run, or task.
- **One event ends each item, with an `outcome`.** Instead of separate `turn.completed`, `turn.failed`, and `turn.cancelled` events, a turn ends with `turn.settled` and an `outcome` of `completed`, `failed`, or `cancelled`. Calls, tasks, deliveries, and requests for input follow the same pattern.
- **Errors share one shape:** `error: { code, message, id?, hint? }`.
- **Token usage has its own event.** Read it from `usage.recorded`, not from turn or session events.
- **Only a person pauses a turn.** A turn that waits on background tasks keeps running. A turn pauses, with `turn.paused`, only while it waits for an approval, a question, or a sign-in.
- **New values can appear without a version change.** Keep a default branch when you switch on event types, kinds, or outcomes.

See [Sessions, runs & streaming](../concepts/sessions-runs-and-streaming) for the full stream format.

### Event mapping

Use this table to rename handlers and filters. When a row says to check a field, one v27 event covers several v26 events, and that field tells them apart.

| v26 event                                                         | v27 event                                                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `message.received`                                                | `delivery.consumed`                                                                                               |
| `message.appended`, `reasoning.appended`                          | `content.delta` (progress; check `kind`)                                                                          |
| `message.completed`, `reasoning.completed`, `result.completed`    | `content.completed` (check `kind`; text with `phase: "reply"` is the answer)                                      |
| `step.started`, `step.completed`, `step.failed`                   | `model.started`, `model.settled` (check `outcome`); `model.requested` comes before model selection                |
| `action.input.appended`, `action.partial`                         | `call.input`, `call.progress` (progress)                                                                          |
| `actions.requested`, `action.result`                              | `call.requested` (one per call), `call.settled`                                                                   |
| `task.started`, `task.settled`                                    | `task.started`, `task.ended`; the call behind the task also has `call.started` (with `taskId`) and `call.settled` |
| `agent.started`                                                   | `child.opened`                                                                                                    |
| `input.requested`, `authorization.required`                       | `interaction.opened` (check `request.kind`, including `"sign-in"`)                                                |
| `input.resolved`, `authorization.completed`, `approval.settled`   | `interaction.settled` (check `outcome`)                                                                           |
| `approval.candidate`                                              | `response.submitted`, `response.settled`                                                                          |
| `compaction.requested`, `compaction.completed`, `context.cleared` | `context.started`, `context.settled` (check `kind`)                                                               |
| `turn.waiting`, `turn.completed`, `turn.failed`, `turn.cancelled` | `turn.paused` (for approvals, questions, and sign-ins), `turn.settled` (check `outcome`)                          |
| `session.waiting`, `session.completed`, `session.failed`          | `delivery.settled` for a request, `session.ended` for a finished session; `idle(view)` for current idleness       |

v27 also adds events with no v26 equivalent:

- `delivery.admitted` when the server accepts a message or control.
- `response.admitted` when the server accepts an answer.
- `model.retried` when a model attempt fails and runs again.
- `usage.recorded` for token usage.
- `child.sent` when a call sends a message to a child session.

### Hooks

Hooks keep the `(event, ctx)` signature. To update a hook:

- Rename its event keys using the [event mapping](#event-mapping).
- Read the session's recorded state from `ctx.view` instead of tracking it yourself, and identify the event with `ctx.position`.
- Subscribe to progress events (`content.delta`, `call.input`, and `call.progress`) by their exact type. A wildcard (`*`) handler doesn't receive them.
- Catch errors from optional work, such as metrics. An unhandled hook error fails the running turn.

See [Hooks](./hooks).

```diff
 import { defineHook } from "eve/hooks";

 export default defineHook({
   events: {
-    "message.completed"(event) {
-      console.log(event.data.message);
+    "content.completed"(event) {
+      if (event.data.phase === "reply") console.log(event.data.value);
     },
   },
 });
```

### Channel `events` handlers

Channel `events` handlers take `(event, ctx)` instead of `(eventData, channel, ctx)`. Read the payload from `event.data`, the turn or call it belongs to from `event.scope`, and the channel from `ctx.channel`. To update a status or card once per stored line instead of once per event, use `committed(line, ctx)`.

Slack renderers take `(event, ctx, next)`. Call `next(event)` to hand the event to the default rendering. See [Custom channels](../channels/custom) and [Slack rendering](../channels/slack#customize-rendering).

### Instrumentation

Type providers with `InstrumentationEvent<K>` and rename their handlers using this table. As in the stream, each item ends with one event whose `outcome` tells success from failure. See [Instrumentation](/docs/observability/instrumentation#lifecycle-events).

| Before                                                  | After                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `session.completed`, `session.failed`                   | `session.ended`                                                        |
| `session.waiting`                                       | No direct equivalent; `delivery.settled` reports each finished message |
| `turn.completed`, `turn.cancelled`, `turn.failed`       | `turn.settled`                                                         |
| `channel.delivery.*`                                    | `delivery.consumed`, `delivery.settled`                                |
| `step.attempt.*`                                        | `model.started`, `model.retried`, `model.settled`                      |
| `model.call.completed`, `model.call.failed`             | `model.call.settled`                                                   |
| `tool.call.*`                                           | `call.requested`, `call.settled`                                       |
| `input.requested`, `input.resolved`                     | `interaction.opened`, `interaction.settled`                            |
| `memory.operation.completed`, `memory.operation.failed` | `memory.operation.settled`                                             |

### Find every consumer

A clean typecheck doesn't find every v26 consumer. Code that parses NDJSON or saved JSON with its own event types compiles against any eve version, and it ignores events it doesn't recognize without an error.

- Search for v26 event names such as `message.completed`, `action.result`, `actions.requested`, and `authorization.required`, not only for `eve` imports. Include scripts, test helpers, and server routes that proxy streams.
- Run a recorded v27 stream through each consumer and check its output. A reducer that returns nothing, or a filter that matches nothing, still compiles.
- Check server code that filters or redacts streamed content before it reaches a browser. A filter keyed on v26 event types passes `content.delta` and `content.completed` through unchanged.
- Check consumers in other deployments, such as remote agents and their callers.

## Approvals, questions, and sign-ins

Approvals, questions, sign-ins, and budget prompts are all requests for input, and one `Interaction` type represents each of them. A person's reply to any of them is an `Answer`: `{ interactionId, optionId?, text? }`. Rename the input-request APIs as follows.

| Before                                                                 | After                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `InputRequest`, `InputResponse`, `requestId`                           | `Interaction`, `Answer`, `interactionId`                         |
| `send({ inputResponses })`, `respond(inputResponses)`                  | `send({ answers })`, `respond(answers)`                          |
| `parseInputResponse(s)`, `isInputResponse`                             | `parseAnswer(s)`, `isAnswer`                                     |
| Response `inputRequests` and `authorizations`                          | `interactions` (sign-ins included)                               |
| `ConversationState.inputs`, `openConversationInputs(state)`            | `interactions(view)`, `openInteractions(view)` from `eve/events` |
| Approval `request.requestId`                                           | `request.interactionId`                                          |
| `onInputResponse` on Slack, Discord, and Teams                         | `onAnswers`                                                      |
| Telegram `renderTelegramInputRequest`, `resolveTelegramInputResponses` | `renderTelegramInteraction`, `resolveTelegramAnswers`            |
| Workflow `ToolInputRequest`, `ToolInputResponse`                       | `ToolQuestion`, `ToolAnswer`                                     |

The approve and deny choices are `APPROVE_OPTION_ID` (`"approve"`) and `DENY_OPTION_ID` (`"deny"`) from `eve/events`, for approvals and budget prompts. Replace checks for a `"cancel"` decision with `"deny"`. Buttons that eve already posted to Slack or another platform keep working.

To learn whether a person approved a tool call, read the interaction's `outcome`, not the call's state:

| `outcome`                  | Meaning                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `accepted`, `declined`     | A person decided.                                                                     |
| `withdrawn`, `interrupted` | Nobody decided, for example because the turn was cancelled. Treat it as not approved. |

See [Interactions](./frontend/use-eve-agent#interactions).

## Clients and frontends

Upgrade the server first. New clients call `POST /eve/v1/session/:sessionId/end`, which older servers don't serve.

### Read results from a delivery

A `Delivery` is the receipt for one message or control. `send()` and the session controls return it as soon as the server accepts the request, before the agent runs. Read the rest from the delivery:

- `delivery.result()` waits for the outcome. Its `status` is `completed`, `awaiting-input`, `failed`, or `cancelled`, and it describes this request, not the session. Check `sessionEnded` to learn whether the session ended.
- `delivery.stream()` yields the events for this request.

Each read is independent and accepts a signal. Results don't include an `events` array, so read events from `delivery.stream()`.

`client.sessions.create()` returns `{ session, delivery }` when you pass a message, and `{ session }` when you don't. See [Client streaming](./client/streaming).

### Replace `reset()` with `end()`

Rename `reset()` to `end()` on client sessions, `SessionStore`, the React, Vue, and Svelte bindings, channel session handles, `ChannelSource` from `eve/channels`, and the Slack handler context (`ctx.end()`). `end()` resolves with a delivery.

```diff
-await session.reset({ reason: "Conversation finished" });
+await session.end({ reason: "Conversation finished" });
```

Move HTTP callers from `POST …/reset` to `POST …/end`. The server still serves `/reset`, and the stream still records the control as `source: { control: "reset" }` on `delivery.admitted`.

`end()` retires the session permanently, and the handle keeps the retired ID. Don't use it for a **New chat** button. Choose the call that matches what the button should do:

| Goal                                                         | Call                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Start a new conversation, and the store creates sessions     | `newSession()`                                                                                              |
| Start a new conversation, and you pass in your own `session` | Create a client session, as below, and bind a new store to it. `newSession()` only clears local state here. |
| Clear the model's context but keep the session               | `clear()`. It cancels a running turn and stops its background tasks.                                        |
| Close the conversation for good                              | `end()`                                                                                                     |

```ts
import { Client } from "eve/client";

const client = new Client({ baseUrl: "https://agent.example" });
const { session } = await client.sessions.create();
await session.send("Start a new conversation.");
```

See [Session controls](./client/overview#sessions).

### Update frontend stores and hooks

| Before                                                            | After                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `EveAgentStore`                                                   | `SessionStore`                                                              |
| `host`                                                            | `baseUrl` (required on a direct client; frontend default `""`)              |
| `data.messages`, `data.agents`, and other fields under `data`     | `view`, `messages`, `agents`, `events`, `session`, `status`, `error`        |
| `conversationReducer`, `defaultMessageReducer`, `EveAgentReducer` | Query `view` with selectors from `eve/events`; read `messages` and `agents` |
| `transcriptReducer(options)`                                      | `transcriptOf(events, options)`                                             |
| `followIdle: true`                                                | Omit `followWhile`                                                          |
| `followIdle: false`                                               | `followWhile: (view) => !idle(view) \|\| activeTurn(view) !== undefined`    |
| Busy status for a Stop control                                    | `activeTurn(view)`                                                          |

Import `idle` and `activeTurn` from `eve/events`. The `followIdle: false` replacement also keeps following while a turn waits for a person.

`messages` shows only the current conversation, so messages from before a clear don't appear. `view` still holds every retained turn.

Save events and the cursor as they arrive, not only when a turn ends, so a turn paused for an approval survives a page reload. See [Frontend](./frontend/overview).

### Flatten reconnect options

Replace `streamReconnectPolicy` with `reconnect`. Move the fields from `streamOpenReconnectPolicy` directly into `reconnect`, and rename `retryableErrorStatuses` to `retryableStatuses`. Defaults are unchanged. Use the `ReconnectOptions` type from `eve/client` instead of `StreamReconnectPolicy` or `StreamReconnectRetryPolicy`. See [Reconnection](./client/streaming#reconnection).

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

To turn off automatic reconnects, replace `streamReconnectPolicy: { reconnect: false }` with `reconnect: false`.

### Handle client errors by code

Every error from `eve/client` extends `EveError` and has a stable snake_case `code`. Narrow with each class's static `is()` instead of `instanceof`, so errors from a separately bundled copy of eve still match.

```diff
-if (error instanceof SessionNotActiveError && error.code === "EVE_SESSION_NOT_ACTIVE") {
+if (SessionNotActiveError.is(error) && error.code === "session_not_active") {
   // Start a new session.
 }
```

`SessionNotActiveError` has one of two codes:

- `session_not_ready`, with `retryable: true`, while the session is still starting. Retry the request.
- `session_not_active` once the session can't take requests. Start a new session.

`ClientError.code` is `http_error` when the server's response had no code.

### Save the full session snapshot

`session.snapshot()` returns the whole `ClientSessionState`, not only `sessionId` and `streamIndex`. It includes an opaque `inbox` value that lets later sends skip a server-side session lookup. Store the snapshot as is, and pass it back unchanged, for example with `client.sessions.attach(saved.sessionId, saved)`. See [Faster sends with `inbox`](./client/overview#faster-sends-with-inbox).

In server code, `sessions.attach(id)` from `eve/server` returns a read-only `SessionReader` with `id` and `stream()`, not a handle that can send. Use `SessionInfo` from `eve/context` for the metadata in `ctx.session`. See [Read a session in process](../concepts/sessions-runs-and-streaming#read-a-session-in-process).

### Check request shapes

- The eve channel rejects unknown top-level fields on session creation, message, and control requests with `400`, naming the fields it accepts. Fix misspelled or unsupported options instead of relying on them being ignored. See [the eve channel](../channels/eve).
- `history` passed to `send()` or `create()` accepts only `id`, `role`, and `text` on each entry, and an unknown field throws `InvalidSessionHistoryError`. Map stored messages to that shape before you pass them.
- Clients reject redirects by default. Point `baseUrl` at the final destination, or set `redirect: "manual"`. See [Authentication](./client/overview#authentication).
- `ctx.agent().send()` file parts must be HTTP(S) URLs, not inline bytes or base64.

### Read agent info with an operator credential

`GET /eve/v1/info` and `client.info()` serve only operators: `service` and `runtime` callers, such as Vercel OIDC, `jwtHmac()`, or `jwtEcdsa()`, and local development through `localDev()`. Other callers, including web chat users, get `403` with code `info_forbidden`.

- Move browser calls to `client.info()` to your server, or hardcode what they show.
- To admit another credential, return `principalType: "service"` or `allowAgentInfo: true` from its eve channel authenticator. `allowAgentInfo: false` denies a caller that would otherwise qualify.
- The client reads an enum value it doesn't know as `"unrecognized"`. Handle that value when you switch on fields such as `mode` or `sourceKind`. Fields named `kind` gain values only with a new agent-info version.

`eve eval` against a deployment also needs an operator credential. See [Agent info access](./auth-and-route-protection#agent-info-access).

## Channels

### Identity, audience, and options

- Authored channel identity is `channel:<name>`, including route-only channels and the default `channel:eve`, which replaces `http`. Update visibility and authorization rules that match the old names.
- Move visibility classification from `metadata().audience` to `audience(input)`. Without it, the audience is `unknown`.
- Channel context factories take `context(state, channel)`. Continuation aliases live on `channel.continuation`.
- Channel delivery hooks receive typed `ChannelDelivery` payloads and return replacements. Use `channel.state` for state changes. Remove `kindHint`.
- Rename the CORS options `allowedHeaders`, `exposedHeaders`, and `preflightStatus` to `allowHeaders`, `exposeHeaders`, and `preflight.statusCode`.
- Sends, channels, and schedules accept `MessageContent`; send images as file parts. In Chat SDK channels, rename `messageToUserContent` to `messageContentOf`.

See [Custom channels](../channels/custom).

### Keep custom data in your own state keys

The built-in channels' default handlers keep internal fields in channel state. Those fields aren't part of the public state types, so don't read or write them; store your own handler data under your own keys. The internal fields include:

- Slack `taskCards` and `threadStatus`
- Chat SDK streaming fields
- `pendingSignIns`, posted prompt cards, `shownPromptId`, and `undeliveredReplyErrorId`
- Discord `interactionToken`, `initialResponseSent`, and `hasMessageAnchor`. Read the interaction token from the Discord handle instead.

`TelegramHitlState` isn't exported. Addressing, identity, and audience fields are unchanged.

### Slack

- **Cards.** Call card builders with their data forms, use `CardText` for labels, and use `cardToFallbackText` for whole cards. Remove imports of `Modal*`, `TextInput*`, `ExternalSelect*`, `CardJSXElement`, `CardJSXProps`, `isCardElement`, `cardChildToFallbackText`, `ChatElement`, `ContainerProps`, and the builder `*Props` types. Use native Slack view data for custom modals. See [Slack cards](../channels/slack#cards).

  ```diff
  -Actions({ children: [Button({ id: "approve", children: "Approve" })] });
  +Actions([Button({ id: "approve", label: "Approve" })]);
  ```

- **Renderers.** `renderers.taskCard` receives a `TaskCard`; use `callState` and `callLabel` from `eve/events` to render calls. `SlackTaskCard` is `SlackCardMessage`. To restyle approval and question cards, use `renderers.interactionCard`. See [Restyle approval and question cards](../channels/slack#restyle-approval-and-question-cards).
- **State.** `SlackChannelState.pendingApprovalCards` is `interactionCards`. Cards posted before the upgrade keep their buttons. `SlackSessionTarget` is a union that includes `{ channelId, codeChannel: true }`, so handle that variant before you read `target.threadTs`.
- **Model context.** The model sees sender, bot, and thread metadata in `<sender>`, `<bot>`, and `<thread>` blocks. Update instructions that mention `sender_type`, `sender_id`, `bot_user_id`, or `is_mentioned`.
- **Proactive messages.** `initialMessage` accepts `{ text }`, `{ markdown }`, `{ blocks, text? }`, or `{ card }`. See [proactive sessions](../channels/slack#proactive-sessions).

### Other channels

- **Teams.** Channel state uses `pendingAuthActivityIds` instead of `pendingAuthActivityId`.
- **MCP.** An `input_required` status can mean a sign-in as well as an approval or a question. Answer approvals and questions with `responses: [{ interactionId, optionId?, text? }]`. A sign-in completes outside MCP. Direct `invokeTool` calls return the call's outcome instead of pausing the conversation. See [MCP](../channels/mcp).
- **Vercel OIDC tool stubs.** `vercelOidc` from `eve/channels/auth` only authenticates. If a `subjects` entry sets `allowToolStubs`, switch to `eveVercelOidc` from `eve/channels/eve`, which takes the same options. Type a custom callback that returns `allowToolStubs` as `EveAuthFn` or `EveAuthResult`.

```diff
-import { vercelOidc } from "eve/channels/auth";
+import { eveVercelOidc } from "eve/channels/eve";

-vercelOidc({
+eveVercelOidc({
   subjects: [{ subject: evalRunner, allowToolStubs: true }],
 });
```

## Workflow imports

Workflow tools import the Workflow SDK through eve. Import durable primitives from `eve/workflow` and run and hook operations from `eve/workflow/api`. Bare `workflow` and `workflow/*` imports fail the build.

```diff
-import { createHook, createWebhook, sleep, FatalError, RetryableError, getWorkflowMetadata } from "workflow";
-import { start, getRun, resumeHook } from "workflow/api";
+import { createHook, createWebhook, sleep, FatalError, RetryableError, getWorkflowMetadata } from "eve/workflow";
+import { start, getRun, resumeHook } from "eve/workflow/api";
```

Only the exports shown above are public. Other Workflow SDK subpaths, helpers, and options aren't available, and the public ones use eve's own types:

- `getHookByToken` is removed. Pass a deterministic `token` to `createHook({ token })`, then resume the hook with `resumeHook(token, payload)`, which resolves to `void`.
- `start(workflow, args?)` takes a `"use workflow"` function, not a source string. It takes no options such as `deploymentId` or `world`, because eve runs the workflow on the agent's own queue and deployment.
- `start` and `getRun` return a `WorkflowRun` with only `runId`, `status`, `returnValue`, and `cancel()`.
- `agent` and `ask` aren't exported. Use `defineWorkflowTool()` from `eve/tools`, and call `ctx.agent(target, input)` or `ctx.ask(request)` in its executor.

```diff
-const hook = await getHookByToken(token);
-await resumeHook(hook, payload);
+await resumeHook(token, payload);
```

Annotate with `WorkflowHook`, `WorkflowWebhook`, and `WorkflowMetadata` from `eve/workflow`, and `WorkflowRun` and `WorkflowRunStatus` from `eve/workflow/api`. Call `eve/workflow/api` operations from routes or `"use step"` helpers, not from replayed workflow bodies. Don't install another Workflow SDK; both entries use eve's bundled copy. You can remove `eve/workflow-modules` from tsconfig `types` and reference directives. See [Workflow imports](../tools/workflows#workflow-imports).

## Remote agents

Remote agent calls use protocol 3. While you upgrade deployments one at a time, callers and remote agents can run different protocol versions:

- A protocol-3 caller relays approvals, questions, and sign-ins from a protocol-2 remote agent.
- A protocol-3 remote agent can't relay them to a protocol-2 caller. Upgrade callers before the remote agents they call, or upgrade both together.
- Callers and remote agents on different protocols can still exchange results.
- Calls to or from eve 0.66 through 0.68 fail at the start with `REMOTE_AGENT_PROTOCOL_MISMATCH`. Upgrade both deployments.

See [Upgrading callers and remote agents](./remote-agents#upgrading-callers-and-remote-agents).

If the caller is protected by Vercel Deployment Protection and the remote agent is in another project, its callbacks need two settings. On the caller, configure Trusted Sources to admit the remote's project and environment. On the remote deployment, list the caller's origins in `EVE_CALLBACK_TRUSTED_ORIGINS`. Callback URLs don't carry the caller's deployment protection bypass secret. See [How remote dispatch and callbacks work](./remote-agents#how-remote-dispatch-and-callbacks-work).

## Evals

Eval assertions match v27 events and read session state from `view`. Rename the eval helpers as follows.

| Before                                                           | After                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `inputRequests`, `pendingInputRequests`, `requireInputRequest()` | `interactions`, `pendingInteractions`, `requireInteraction()` |
| `loadedSkill`                                                    | `calledSkill`                                                 |
| `calledSubagent`                                                 | `calledAgent`                                                 |
| `noFailedActions`                                                | `noFailedCalls`                                               |
| `parked()`                                                       | `awaitingInput()`                                             |
| `attachSession(id)`                                              | `t.target.attach(id)`                                         |
| Action matchers                                                  | `turn.waitForToolCall()`                                      |
| `remoteUrl` field and matcher                                    | Removed                                                       |

See [Evals](../evals/overview).

## CLI

| Before              | After                                 |
| ------------------- | ------------------------------------- |
| `eve remote invoke` | `eve remote connect --print <prompt>` |
| `--tools`           | `--show-tools`                        |
| `--reasoning`       | `--show-reasoning`                    |
| `--subagents`       | `--show-subagents`                    |
| `--connection-auth` | `--show-connection-auth`              |

`eve remote connect --print <prompt>` sends one prompt, prints the final reply, and exits. For scripted multi-turn sessions and answers, use `eve/client`.

The display flags apply to `eve dev` and `eve remote connect`. They take the same values as before, and the old names aren't aliases. `--reasoning` on `eve init` and `eve set model` still sets the model's reasoning effort. See the [CLI reference](../reference/cli).

```bash
eve dev --show-reasoning full --show-tools auto-collapsed
```

## Saved session history

Skip this section if your application doesn't store session events.

The server's own copy of a stream needs no migration. A session that started on 0.83 or earlier keeps the lines it already stored, and new v27 lines are appended after them. The new deployment serves the whole stream as v27 events, and cursors you saved still point at the same lines.

Copies your application saved itself are different. Events saved before the upgrade are v26 events, and `SessionStore` can't load them as `initialEvents`. Pick the path that matches what you have:

| What you have                                                          | Do this                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| The session's stream is still available                                | Read it again from position 0 and replace what you saved.                            |
| The saved array is the only copy                                       | Convert it once with `convertLegacyEvents` and store the result.                     |
| A record with v26 events followed by v27 events, and an expired stream | Convert only the v26 prefix. Keep the later v27 events and their metadata unchanged. |
| Message lists produced by v26 reducers                                 | Don't convert them. Re-read the stream, or render the lists as read-only records.    |

```ts
import { convertLegacyEvents } from "eve/internal/legacy-events";

// One session's saved events, from its `session.started` on, as they were saved.
const events = convertLegacyEvents(saved);
```

Store the converted events with their metadata unchanged and pass them as `SessionStore`'s `initialEvents`. Their metadata records which saved lines they came from, including lines that produced no v27 events, and `SessionStore` uses it to resume reading at the right line. The number of converted events doesn't match the number of lines, so don't compute a resume position from it or from another reader's cursor. See [Resumable sessions](./frontend/overview#resumable-sessions).

`convertLegacyEvents` converts one session at a time. It throws for an array that doesn't start at `session.started`, holds a second session, or already holds v27 events. A session saved mid-turn converts to an unfinished turn. The function is a temporary migration aid with no compatibility promise, and a later release removes it, so convert once and store the result.

Before you hydrate or convert a saved record:

- **Select one session.** A chat record can hold several sessions, for example after a chat moves to a new session or a fork copies its parent's history. Pass only the current session's events, from its `session.started`.
- **End computed cursors at a complete line.** An event with `meta.endOfLine: false` has more events in the same line. Stop a cursor you compute at the last complete line.
- **Treat missing data as unknown.** A partial read must not overwrite a fuller archive, and an expired stream must not replace saved history with an empty one. A child session you can't read anymore hasn't necessarily completed.
- **Guard concurrent writes.** Browser saves, server catch-up reads, and background capture can race. Bind each write to its session, reject a cursor that moves backward, and track each child session's progress apart from its parent's.
- **Keep copied history read-only.** Approvals and sign-ins in a fork, shared copy, or old transcript belong to the original session. Render them as records, not live controls.
- **Qualify IDs with the session.** Turn and message IDs aren't unique across sessions. Include the session ID in keys when one record holds several sessions.

## Apps that track session state

Skip this section if you use `useEveAgent` or `SessionStore` without reducers or stream followers of your own.

If your application followed streams, folded events, or tracked turn status itself, much of that code duplicates what eve now provides. Decide what each piece of state is for:

| Let eve own                                       | Keep in your application                                           |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Turn status and what happens from start to finish | Saved archives and their cursors                                   |
| Streaming and reconnection                        | Forks and shared copies                                            |
| Optimistic sends                                  | Feedback, authorization, and policy for who may answer             |
| Pending approvals, questions, and sign-ins        | Budgets you wrote, and ledgers of external effects such as uploads |

Replace your own status tracking as a whole instead of layering it on `SessionStore`. A second reducer becomes another source of truth that can disagree with eve's. Map `messages`, `view`, and the message parts for approvals and questions into your existing components instead.

### Replace code eve owns

| Usually replaceable                                                    | Replacement                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Custom stream followers, reconnect loops, and optimistic-send state    | `useEveAgent` or `SessionStore`                                                                              |
| Hook or session state that mirrors turns, calls, tasks, or models      | `ctx.view` and selectors from `eve/events`                                                                   |
| Folds over raw events for status, replies, timing, usage, or cursors   | The queries in [Use eve's answers](./frontend/use-eve-agent#use-eves-answers)                                |
| Hand-written finite stream readers and history scanners                | `session.stream({ follow: false })` or `session.snapshot()`                                                  |
| Conversions from `Interaction` to a custom request shape and back      | Native `Interaction` values and the channel's interaction rendering                                          |
| Code that retires Slack approval cards and sign-in messages eve posted | Remove it; eve updates those Slack messages. Check each channel's docs before removing code for other cards. |
| An explicit `turnPolicy: "steer"` on follow-ups                        | Omit it; messages steer an open turn by default                                                              |
| Local v26-to-v27 event translators                                     | `convertLegacyEvents` during migration, or a fresh read from position 0                                      |
| Tests that only exercised removed machinery                            | Delete them with that machinery                                                                              |

Keep code that enforces your own rules. That includes archive storage and cursor guards, effect ledgers and deduplication receipts, authorization checks, budgets you wrote, `operationId` retries, and product UI such as composers, branches, and sharing.

### Attribute results to the right message

- **Bind each outcome to its delivery.** Use `delivery.result()` or that delivery's own turn, not the session's latest turn or every event after a polling cursor. Otherwise a queued or concurrent turn can claim another turn's output.
- **Follow child sessions by link.** For a child session that several calls reuse, follow the `child.sent` links from a call, for example with `agentCallActivity(state, callId)` from `eve/client`. Don't count `delivery.consumed` on the child's stream, because answers to the child's questions are deliveries too. See [Child agents](./frontend/use-eve-agent#child-agents).
- **Identify runs by ID.** A steering message adds a run to the same turn, and a retry reuses its run ID. Use `turn.started` for once-per-turn work, and `runId` with `turnId` for a specific run.
- **Treat acceptance as admission.** When an outcome is unconfirmed, read it again instead of resending after a timeout. Use `operationId` for create requests you retry; see [the eve channel](../channels/eve).
- **Read payloads by their documented shape.** `turn.settled.data.reply` lists the reply's part IDs, not its text. Use `reply(ctx.view, turnId)` in hooks and channels, or `messages` in the frontend.

## Troubleshooting

| What you see                                                                    | What to do                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Extension "<name>" uses an old epoch-based distribution manifest`              | Rebuild the extension with the new release, or install a compatible extension release.                         |
| `Export defineAgent({...}) from "<path>".`                                      | [Export `defineAgent`](#export-defineagent-from-every-agentts) from that file.                                 |
| `Rename "compaction.thresholdPercent" to "compaction.threshold"`                | [Rename the field](#rename-compactionthresholdpercent) and keep its value.                                     |
| ``Import from `eve/workflow` (or `eve/workflow/api`) instead of "workflow"``    | [Update Workflow imports](#workflow-imports).                                                                  |
| `400` naming unknown fields from the eve channel                                | Remove or correct the fields, or upgrade the server; see [Check request shapes](#check-request-shapes).        |
| `InvalidSessionHistoryError`                                                    | Map `history` entries to `{ id, role, text }`.                                                                 |
| `403` with code `info_forbidden`                                                | Call `client.info()` with an [operator credential](#read-agent-info-with-an-operator-credential).              |
| `end()` or `POST /eve/v1/session/:sessionId/end` fails against an older server  | Deploy the upgraded server before the upgraded client.                                                         |
| `REMOTE_AGENT_PROTOCOL_MISMATCH`                                                | Upgrade both deployments; see [Remote agents](#remote-agents).                                                 |
| Hooks, dashboards, or UI show nothing after the upgrade, with no errors         | A consumer still matches v26 event names; see [Find every consumer](#find-every-consumer).                     |
| Sandbox commands fail with `pnpm: command not found` or a refused `pip install` | Install them in `prepare`; see [Choose one sandbox layout](#choose-one-sandbox-layout-and-install-your-tools). |

## Verify the upgrade

1. Run your typecheck and `eve build`.
2. Create a conversation, send a message, end it, and start another.
3. Restore a saved session state and send to it.
4. Approve a tool call. Then cancel a turn while an approval is pending, and send a message while a sign-in is pending.
5. Run a recorded v27 stream through each event consumer, and check that hooks, dashboards, and UI show the expected output.
6. Test history paths you support: expired streams, sessions saved mid-turn, forks, records holding several sessions, and records written across the upgrade. Build those fixtures from real saved data and pass them through a JSON round trip.
7. Call `client.info()` with an operator credential if your tooling uses it.
8. Test proactive Slack messages and durable workflow waits your project defines.

Review [run-data retention](../agent-config#run-data-retention) before you rely on a finished transcript staying readable. Outside development, the default trace policy for private and unknown-audience sessions requests deletion when the session ends; whether data is deleted depends on the backend.
