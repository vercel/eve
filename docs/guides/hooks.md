---
title: "Hooks"
description: "Subscribe to runtime stream events from agent/hooks/."
---

Hooks are eve's authored extension points for the runtime event stream. A hook subscribes to stream events and runs side effects after each event is durably recorded, such as audit logging, metrics and alerting, or persisting every session and message to your own database for analytics. Reach for one to observe what the agent does without writing a tool, a context provider (a value made available across a step), or a channel adapter handler (a handler defined on a channel's adapter; see [Channels](../channels/overview)).

## Define a hook

```ts title="agent/hooks/audit.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "session.started"(_event, ctx) {
      console.info("session started", { sessionId: ctx.session.id });
    },
    async "content.completed"(event) {
      if (event.data.phase !== "reply" || event.data.kind !== "text") return;
      console.info("reply part", { length: String(event.data.value ?? "").length });
    },
  },
});
```

The slug is the path-relative basename. `agent/hooks/audit.ts` becomes `"audit"`, and `agent/hooks/auth/load-profile.ts` becomes `"auth/load-profile"`.

`defineHook`, `HookDefinition`, and `HookContext` live on `eve/hooks`.

A hook file declares stream-event subscribers under the `events` map, keyed by fact type, with `*` matching every fact. Subscribe to any fact in the v27 catalog documented in [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming), such as `session.started`, `turn.settled`, `content.completed`, and `call.settled`. Progress records (`content.delta`, `call.input`, `call.progress`) reach only handlers keyed on their type, never `*`. Handlers can call external services and cancel the running turn. They cannot inject model context. To contribute runtime model messages, use `defineDynamic` and `defineInstructions` in `agent/instructions/`.

## Scope side effects to a channel

A hook under `agent/hooks/` observes matching events from every channel on the root agent. `defineHook` has no channel filter. Use a channel's `events` configuration when a handler assumes a specific platform or should run only for sessions owned by that channel:

```ts title="agent/channels/github.ts"
import { githubChannel } from "eve/channels/github";

export default githubChannel({
  events: {
    async "turn.settled"(event, ctx) {
      console.info("GitHub turn settled", {
        outcome: event.data.outcome,
        repository: ctx.channel.repository.fullName,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
  },
});
```

A GitHub channel event handler cannot fire for a Slack-owned session, so platform-specific side effects do not depend on an early-return guard. On a built-in channel, an authored handler replaces that channel's default handler for the same event key. Check the channel page before overriding events that deliver replies, progress, errors, or human-input prompts. The [Slack channel](/docs/channels/slack#customize-rendering) takes renderers instead: a renderer's handler keeps Slack's default by calling `next()` and replaces it by skipping `next`.

Use `ctx.channel.kind` inside a global hook only when the operation is otherwise agent-wide and conditional handling is intentional. For a channel with event handlers, such as `githubChannel`, `slackChannel`, and the other built-ins, the kind is the path-derived identity. `agent/channels/github.ts` reports `channel:github`, so `ctx.channel.kind === "github"` never matches. Import the channel definition and compare it with `isChannel` from `eve/channels`:

```ts title="agent/hooks/github-only.ts"
import { isChannel } from "eve/channels";
import { defineHook } from "eve/hooks";

import github from "../channels/github";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      if (!isChannel(ctx.channel, github)) return;
      // GitHub-owned turns only.
    },
  },
});
```

Route-only channels use the same path-derived identity, even when they have no event handlers. Use `isChannel` with the authored channel definition rather than checking for the former `"http"` kind.

For typed channel metadata in dynamic resolvers or instrumentation, narrow with `isChannel` the same way; see [OpenTelemetry runtime context](../observability/otel#add-runtime-context).

## Hook structure and context

Every handler receives the same `HookContext`, including the shared session
helpers documented in [Session context](./session-context):

```ts
interface HookContext extends SessionContext {
  readonly agent: { readonly name: string; readonly nodeId?: string };
  readonly channel: { readonly kind?: string; readonly continuationToken?: string };
  /** Where the event sits on the stream: its line, and its index in that line. */
  readonly position: { readonly line: number; readonly index: number };
  /** Immutable session snapshot as of the whole commit the event is in. */
  readonly view: SessionView;
  readonly turn: DynamicTurn | null;
  readonly now: Date;
  readonly occurrence: { readonly idempotencyKey: string; readonly abortSignal: AbortSignal };
  readonly memo: Memo;
  cancel(reason?: string): void;
}
```

That means a hook can access the current sandbox and release its backing
compute at an application-defined boundary:

```ts title="agent/hooks/stop-after-turn.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "turn.settled"(_event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.stop();
    },
  },
});
```

Every built-in backend stops its underlying compute while preserving the
durable session and filesystem for the next callback. On Vercel, the current
handle can also automatically resume on later I/O. A hook failure, including a
failed stop, follows the normal
[hook failure behavior](#what-happens-when-a-hook-throws).

`ctx.turn` is the latest turn, including a settled one, or `null` before the first turn. `ctx.now` is the commit time. `ctx.memo(key, fn)` follows the [dynamic-value memo rules](./dynamic-capabilities#memo-rules). Hooks do not receive assembled conversation history.

`ctx.view` is the session's state as of the event's whole commit, folded by the same code as
`eve/events`. Read what changed from the event, and where things stand from the view: for
example, `call(ctx.view, event.data.callId)` from `eve/events` on a `call.settled` returns its
name, kind, input, output, and state. The view has no public tables; queries return immutable
observations. A retained snapshot stays unchanged after later events.

For `task.started`, `task.ended`, and `child.opened`, `ctx.session.id`
identifies the session that started the task or opened the subagent session.
Typed handlers and `*` handlers receive this context even when the event
arrives between turns. These hooks can use `ctx.getSandbox()` against that
session. Session state and sandbox changes they make are kept for the
session's next turn. `child.opened` appears when the child session opens.

### Narrowing tool results

`toolResultFrom` narrows a settled call to a specific authored tool or connection (MCP or OpenAPI) and returns typed output. Pass it the observation from `call(ctx.view, callId)`, which carries the call's name, kind, state, and output. Import it from `eve/tools`:

```ts
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { call } from "eve/events";
import getWeather from "../tools/get-weather";
import linear from "../connections/linear";

export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      const observed = call(ctx.view, event.data.callId);

      // Authored tool: output is typed as the tool's return type
      const weather = toolResultFrom(observed, getWeather);
      if (weather) {
        console.log(weather.output.temperature);
      }

      // Connection: output is unknown, toolName is qualified
      const linearResult = toolResultFrom(observed, linear);
      if (linearResult) {
        console.log(linearResult.connectionToolName, linearResult.output);
      }
    },
  },
});
```

Returns `undefined` when the call doesn't match, or when it didn't complete. For authored tools the return includes `{ output, toolName, callId }` with `output` typed as the tool's `TOutput`. For connections it includes `{ output, toolName, connectionToolName, callId }` with `output` as `unknown`.

This works for a mounted extension's tools too — import the tool from the extension's `./tools` export and pass it. `toolResultFrom` matches the namespaced call (`crm__search`) because it keys off the tool definition, not the name:

```ts
import { search } from "@acme/crm/tools";
import { call } from "eve/events";

// inside "call.settled":
const crmSearch = toolResultFrom(call(ctx.view, event.data.callId), search); // typed; matches crm__search
```

When one definition is mounted under more than one tool name, for example when a subagent re-exports an extension tool, `toolResultFrom` matches calls from every mounted name.

### Persist events to your own database

Every event a hook receives has its stream position as `ctx.position`. A position never changes, so `(session, line, index)` makes a natural primary key for an events table:

```ts title="agent/hooks/persist.ts"
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "*"(event, ctx) {
      await db.query(
        `insert into agent_events (session_id, line, index, type, data)
         values ($1, $2, $3, $4, $5)
         on conflict (session_id, line, index) do nothing`,
        [ctx.session.id, ctx.position.line, ctx.position.index, event.type, event.data],
      );
    },
  },
});
```

A consumer that re-reads the stream gets the same positions, so the key above deduplicates ingestion. If a step is interrupted after publishing but before checkpointing, its retry does not run hooks again for what it already published. New recovery facts run their hooks normally. Some handlers may already have run while others never ran; this is not an exactly-once effect guarantee.

Pass `ctx.occurrence.idempotencyKey` to services that support idempotency. It identifies this handler's fact position. For one effect per turn or call, use that resource's identity instead, such as `turnId` or `callId`. Effects such as one alert per session still need author-managed durable state. `ctx.memo` caches observations, not effect receipts; its records can be discarded on deployment changes.

See [Positions](../concepts/sessions-runs-and-streaming#positions) for the full contract.

## Execution order

Each committed line is published in this order:

1. Write. The line is written to the durable stream.
2. Channel delivery. The channel adapter handler runs for each fact.
3. Hooks. Stream-event hooks fire (typed handlers first, then the `*` wildcard). Return values are ignored.
4. Cancellation requests queued by `ctx.cancel()` take effect after the handlers return.

Before an ordinary model call, dynamic functions compute the model and capabilities from the latest committed session. They do not subscribe to events.

Hooks always run after the line is durably recorded, so if a hook throws, the stream stays consistent.

## What happens when a hook throws

An unhandled error fails the running turn before its next model call or as it would settle. Between turns there is no active turn to fail, so eve logs the error without changing an earlier outcome. Catch errors from optional audit or metrics work if the turn should continue. To stop without a failure, call [`ctx.cancel(reason?)`](#cancel-the-running-turn-from-a-hook).

A hook failure does not trigger a retry. State changes and external side effects made before the exception are not rolled back. If a side effect needs retries or compensation, handle that inside the hook. Runtime failures outside the authored handler, such as failures setting up context or persisting state, still propagate. If a published fact outlives its step's checkpoint, the step's retry does not run the hook again.

## Cancel the running turn from a hook

Call `ctx.cancel(reason?)` when a hook finds that the turn cannot proceed. For example, a `turn.started` hook that cannot load the caller's credentials can stop the turn before the model runs, instead of letting every tool call fail:

```ts title="agent/hooks/require-credentials.ts"
import { defineHook } from "eve/hooks";
import { loadWorkspaceCredentials } from "../lib/credentials";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      try {
        await loadWorkspaceCredentials(ctx.session.auth.current);
      } catch (error) {
        console.warn("cancelling turn: workspace credentials unavailable", {
          error,
          sessionId: ctx.session.id,
        });
        ctx.cancel("Workspace credentials are unavailable.");
      }
    },
  },
});
```

The remaining subscribers for the event still run. Then eve cancels the turn the same way [`session.cancel()`](./client/streaming) does: in-flight model and tool work is aborted, delegated child turns are cancelled, and the turn settles with `outcome: "cancelled"` and `cause: { hook }` naming the hook. No failure is recorded. A cancel from `turn.started` or `model.requested` takes effect before that model call. In a conversation, the next message starts a new turn. A delegated task reports the cancellation to its caller.

A plain-text message that answers a pending question, such as one from `ask_question`, is recorded as `delivery.consumed` before eve delivers it. Calling `ctx.cancel()` from that event's hook cancels the turn instead: the question settles as `interrupted`, and the waiting tool call never receives the text.

The same goes for the `call.progress` a workflow tool reports while the turn waits on it: `ctx.cancel()` from its hook cancels the turn, and the run's result never reaches the model.

`ctx.cancel()` returns `void` rather than a promise. The turn stops after the hook returns, so there is nothing to await. Call it before the handler's promise settles: a call from work the handler did not await throws. A cancel counts only if the handler returns: a handler that calls `ctx.cancel()` and then throws fails the turn instead.

`ctx.cancel()` targets the turn being processed, including while its input is being admitted. Calls between turns without an incoming turn do nothing. Repeated requests cancel that turn only once; they never cancel a later turn. Hook-side `ctx.compact` and `ctx.once` are not available. Client and channel session compaction APIs are unchanged.

## Subagent isolation

Subagents may carry their own `agent/hooks/` directory. Subagent hooks fire only inside the subagent scope. Parent-agent hooks do not fire for subagent turns, and subagent hooks see only the subagent's own context.

A subagent's approvals, questions, and sign-ins are also relayed to the parent stream, as the parent's own `interaction.opened` facts. Parent hooks observe them after the stream write, with the parent's session, agent, and channel context. A relayed interaction's `subject` names the parent call that waits on it, and its `origin` names the child session and request that asked, with `origin.call` naming the child's call. When the parent's turn is paused on that child, the relayed request pauses it on the person too. The child's settlement is relayed as the parent's `interaction.settled`.

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
- [Session context](../reference/typescript-api)
- [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming)
