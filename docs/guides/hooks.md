---
title: "Hooks"
description: "Subscribe to runtime stream events from agent/hooks/."
---

Hooks are Eve's authored extension points for the runtime event stream. A hook subscribes to stream events and runs side effects after each event is durably recorded: audit logging, metrics and alerting, or persisting every session and message to your own database for analytics. Reach for one when you want to observe what the agent does without writing a tool, a context provider, or a channel adapter handler.

## Define a hook

```ts title="agent/hooks/audit.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      console.info("session started", { sessionId: ctx.session.id });
    },
    async "message.completed"(event) {
      console.info("model finished", { length: event.data.message?.length ?? 0 });
    },
  },
});
```

The slug is the path-relative basename: `agent/hooks/audit.ts` becomes `"audit"`, and `agent/hooks/auth/load-profile.ts` becomes `"auth/load-profile"`.

`defineHook`, `HookDefinition`, and `HookContext` live on `eve/hooks`. The `defineState` helper lives on `eve/context`.

## Shape

A hook file declares stream-event subscribers under the `events` map:

```ts
defineHook({
  events: {
    "session.started"(event, ctx) {
      /* ... */
    },
    "turn.completed"(event, ctx) {
      /* ... */
    },
    "*"(event, ctx) {
      /* wildcard: fires for every event */
    },
  },
});
```

Handlers are observe-only: they cannot inject model context. To contribute runtime model messages, use `defineDynamic` + `defineInstructions` in `agent/instructions/`.

Every handler receives the same `HookContext`:

```ts
interface HookContext {
  readonly agent: { readonly name: string; readonly nodeId?: string };
  readonly channel: { readonly kind?: string; readonly continuationToken?: string };
  readonly session: { readonly id: string };
}
```

### Narrowing tool results

`toolResultFrom` narrows an `action.result` event to a specific authored tool or MCP connection and returns typed output. Import it from `eve/tools`:

```ts
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import getWeather from "../tools/get-weather";
import linear from "../connections/linear";

export default defineHook({
  events: {
    "action.result"(event) {
      // Authored tool: output is typed as the tool's return type
      const weather = toolResultFrom(event.data.result, getWeather);
      if (weather) {
        console.log(weather.output.temperature);
      }

      // MCP connection: output is unknown, toolName is qualified
      const linearResult = toolResultFrom(event.data.result, linear);
      if (linearResult) {
        console.log(linearResult.connectionToolName, linearResult.output);
      }
    },
  },
});
```

Returns `undefined` when the result doesn't match, or when `isError` is `true`. For authored tools the return includes `{ output, toolName, callId }` with `output` typed as the tool's `TOutput`. For connections it includes `{ output, toolName, connectionToolName, callId }` with `output` as `unknown`.

## Stream events

Side-effect-only handlers for accepted runtime events. Subscribe by event type, or use `*` for every event:

```ts title="agent/hooks/observability.ts"
import { defineHook } from "eve/hooks";
import { datadogCounter } from "../lib/datadog";
import { postToHoneycomb } from "../lib/honeycomb";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      await postToHoneycomb({ event: "session.started", sessionId: ctx.session.id });
    },
    async "message.completed"(event) {
      await postToHoneycomb({ event: "message.completed", payload: event.data });
    },
    async "*"(event) {
      datadogCounter(`eve.event.${event.type}`).increment();
    },
  },
});
```

### Execution order

When a stream event fires, three things happen in order:

1. Emit: the channel adapter handler runs, then the event is written to the durable stream.
2. Hooks: stream-event hooks fire (typed handlers first, then the `*` wildcard). Return values are ignored.
3. Dynamic tool resolvers: resolvers subscribed to the event type run and update the tool set.

Hooks always run after the event is durably recorded, so if a hook throws, the stream stays consistent.

## Errors

| Stage      | On throw                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `events.*` | Propagates through the emit composer and surfaces as `turn.failed`. If a hook subscribed to a failure-cascade event also throws, it escalates to `session.failed`. |

For belt-and-suspenders semantics inside a hook, wrap the body in `try`/`catch`. Eve treats a thrown hook as a real failure.

## Subagent isolation

Subagents may carry their own `agent/hooks/` directory. Subagent hooks fire only inside the subagent scope: parent-agent hooks do not fire for subagent turns, and subagent hooks see only the subagent's own context.

## Hook vs tool vs provider

| Need                                              | Use                                            |
| ------------------------------------------------- | ---------------------------------------------- |
| Observe runtime events (audit, metrics, alerting) | `events.<type>` (or a channel adapter handler) |
| Provide structured input to the model on demand   | a tool                                         |
| Make a value available across the entire step     | a context provider                             |
| Subscribe to platform-specific events             | a channel adapter handler                      |

Stream-event hooks and channel adapter event handlers are structurally identical. Choose the channel adapter handler when you are authoring adapter-specific behavior, and choose `events.*` when you are authoring agent-level behavior that should fire across every channel. Both fire when both are registered.

## What to read next

- [Tools](../tools)
- [Context control](../concepts/context-control)
- [Session context](./session-context)
- [Sessions, runs & streaming](../concepts/sessions-runs-and-streaming)
