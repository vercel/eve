---
title: "Prepare for 1.0"
description: "Update session controls, authoring definitions, imports, retry options, and terminal flags for the pre-1.0 API cleanup."
url: /guides/prepare-for-1-0
---

Use this checklist when upgrading an existing project to the coordinated pre-1.0 API cleanup release. These changes do not make the release 1.0; the [stability policy](../reference/typescript-api#stability-policy) still distinguishes stable and experimental APIs.

Update agent servers before client applications. New clients call the `/end` endpoint, which older servers do not serve. Then update your authored files, frontend code, and scripts as described below.

## End a session or start a new conversation

Replace retirement methods named `reset()` with `end()` on client sessions, `SessionStore`, React/Vue/Svelte bindings, channel session handles, and Slack session callbacks:

```diff
-await session.reset({ reason: "Conversation finished" });
+await session.end({ reason: "Conversation finished" });
```

The HTTP endpoint changes from `POST /eve/v1/session/:sessionId/reset` to `POST /eve/v1/session/:sessionId/end`.

Ending permanently retires the session and leaves the handle on the retired ID. Do not use `end()` for a **New chat** button. Use `newSession()` on a frontend binding or store, or create a new client session:

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

## Wrap connection definitions

Every connection must use the helper for its protocol. A plain object is no longer assumed to be an MCP connection:

```diff
-export default { url: "https://issues.example/mcp" };
+import { defineMcpClientConnection } from "eve/connections";
+
+export default defineMcpClientConnection({ url: "https://issues.example/mcp" });
```

Use `defineOpenAPIConnection` for OpenAPI connections. Keep the helper inside the dynamic factory when authoring a dynamic connection. See [Connections](../connections).

## Choose one sandbox layout

If both `agent/sandbox.ts` and `agent/sandbox/` exist, move the definition to `agent/sandbox/sandbox.ts`. The combination now fails discovery instead of silently ignoring the root definition.

A standalone `agent/sandbox.ts` remains supported. See [Sandbox layout](../sandbox#define-an-environment).

## Move workspace helper imports

Import workspace helpers from the experimental entry:

```diff
-import { defineWorkspaceAgent } from "eve";
+import { defineWorkspaceAgent } from "eve/experimental/workspace";
```

Move `WorkspaceAgentDefinition` and `WorkspaceAgentTransport` type imports to the same entry. The `agents/<name>/` workspace layout and `withEve` from `eve/vercel` stay stable; the helper's experimental status does not change them.

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

Use the exported `ReconnectOptions` type from `eve/client` instead of `StreamReconnectPolicy`, `ResolvedStreamReconnectPolicy`, or `StreamReconnectRetryPolicy`. The option also applies to client session and event readers. Defaults and cursor recovery are unchanged; following reads keep reconnecting, and server-side readers do not reconnect. See [Streaming](./client/streaming#reconnection).

## Update Workflow imports

Import durable primitives from `eve/workflow`, and run/hook operations from `eve/workflow/api`:

```diff
-import { createHook, createWebhook, sleep, FatalError, getWorkflowMetadata } from "workflow";
-import { start, getRun, resumeHook, getHookByToken } from "workflow/api";
+import { createHook, createWebhook, sleep, FatalError, getWorkflowMetadata } from "eve/workflow";
+import { start, getRun, resumeHook, getHookByToken } from "eve/workflow/api";
```

Bare `workflow` and `workflow/*` imports in authored modules now fail the build. Only the exports listed above are public; other SDK subpaths and helpers are not supported by these entries. Call `eve/workflow/api` operations from routes or `"use step"` helpers, not replayed workflow bodies. Both entries use eve's bundled SDK; do not install another SDK to make these imports resolve.

You can remove `eve/workflow-modules` from tsconfig `types` and reference directives. Existing references remain resolvable through 1.x, but the entry no longer declares bare modules. See [Workflow imports](../tools/workflows#workflow-imports).

## Remove unsupported Slack card imports

Remove these exports from `eve/channels/slack` imports:

- `Modal*`, `TextInput*`, and `ExternalSelect*` builders and their associated types.
- `CardJSXElement` and `CardJSXProps`.
- `isCardElement` and `cardChildToFallbackText`.

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

Run your project's typecheck and `eve build`, then check the workflows you use: create a conversation, send a message, end it, and start another. Test any proactive Slack messages and durable workflow waits your project defines.

Review [run-data retention](../agent-config#run-data-retention) before depending on a completed transcript remaining readable. This cleanup does not change the retention default: outside development, the default trace policy for private and unknown-audience sessions requests deletion when the session ends. Backend support determines whether deletion occurs; the current override remains experimental.
