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

A hook file declares stream-event subscribers under the `events` map, keyed by fact type, with `*` matching every fact. Subscribe to any fact in the v27 catalog documented in [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming), such as `session.started`, `turn.settled`, `content.completed`, and `call.settled`. Progress records (`content.delta`, `call.input`, `call.progress`) reach only handlers keyed on their type, never `*`. Handlers are observe-only. They cannot inject model context. To contribute runtime model messages, use `defineDynamic` and `defineInstructions` in `agent/instructions/`.

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

Use `ctx.channel.kind` inside a global hook only when the operation is otherwise agent-wide and conditional handling is intentional. For typed channel metadata in dynamic resolvers or instrumentation, import the channel definition and narrow with `isChannel`; see [OpenTelemetry runtime context](../observability/otel#add-runtime-context).

## Hook structure and context

Every handler receives the same `HookContext`, including the shared session
helpers documented in [Session context](./session-context):

```ts
interface HookContext extends SessionContext {
  readonly agent: { readonly name: string; readonly nodeId?: string };
  readonly channel: { readonly kind?: string; readonly continuationToken?: string };
  /** Where the event sits on the stream: its line, and its index in that line. */
  readonly position: { readonly line: number; readonly index: number };
  /** The session's tables as of the whole commit the event is in. */
  readonly view: SessionView;
  cancel(): void;
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

`ctx.view` is the session's state as of the event's whole commit, folded by the same code as
`eve/events`. Read what changed from the event, and where things stand from the view: for
example, `ctx.view.calls[event.data.callId]` on a `call.settled` holds the call's capability and
input as well as its outcome.

For `task.started`, `task.ended`, and `child.opened`, `ctx.session.id`
identifies the session that started the task or opened the subagent session.
Typed handlers and `*` handlers receive this context even when the event
arrives between turns. These hooks can use `ctx.getSandbox()` against that
session. Session state and sandbox changes they make are kept for the
session's next turn. `child.opened` appears when the child session opens.

### Narrowing tool results

`toolResultFrom` narrows a settled call to a specific authored tool or MCP connection and returns typed output. Pass it the call's row from `ctx.view`, which carries the call's capability and output. Import it from `eve/tools`:

```ts
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import getWeather from "../tools/get-weather";
import linear from "../connections/linear";

export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      const call = ctx.view.calls[event.data.callId];

      // Authored tool: output is typed as the tool's return type
      const weather = toolResultFrom(call, getWeather);
      if (weather) {
        console.log(weather.output.temperature);
      }

      // MCP connection: output is unknown, toolName is qualified
      const linearResult = toolResultFrom(call, linear);
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

// inside "call.settled":
const crmSearch = toolResultFrom(ctx.view.calls[event.data.callId], search); // typed; matches crm__search
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

A consumer that re-reads the stream gets the same positions, so ingesting an event twice is safe. Hooks are still at-least-once: if the step that published a line is interrupted after its hooks ran, a retry can run them again for the same position, and the key above absorbs that.

A side effect that must happen once per turn or call — a charge, an email, a ticket — keys well on the fact's own identity, such as `turnId` on `turn.settled` or `callId` on `call.settled`. Each is introduced once and settles once.

See [Positions](../concepts/sessions-runs-and-streaming#positions) for the full contract.

## Execution order

When a session commits facts while it runs, the step that owns the session does four things in order:

1. Write. The line is written to the durable stream.
2. Channel delivery. The channel adapter handler runs for each fact.
3. Hooks. Stream-event hooks fire (typed handlers first, then the `*` wildcard). Return values are ignored.
4. Model preparation, for model lifecycle events. Dynamic resolvers subscribed to those events update the model context. Subagent notifications do not run model preparation.

Hooks always run after the line is durably recorded, so if a hook throws, the stream stays consistent.

## What happens when a hook throws

eve logs a thrown or rejected handler with the hook slug, subscription, event type, position, and session ID, then runs the remaining subscribers in order. The current turn, subagent notification, and session continue. This applies to every stream-event hook, including `turn.started`, `model.requested`, and failure settlements. Throwing from a hook does not reject work or veto a turn. To stop the running turn, call [`ctx.cancel()`](#cancel-the-running-turn-from-a-hook).

A hook failure does not trigger a retry. State changes and external side effects made before the exception are not rolled back. If a side effect needs retries or compensation, handle that inside the hook. Runtime failures outside the authored handler, such as failures setting up context or persisting state, still propagate. If persisting state after a `task.started`, `task.ended`, or `child.opened` fact fails, the workflow runtime retries the publishing step.

## Cancel the running turn from a hook

Call `ctx.cancel()` when a hook finds that the turn cannot proceed. For example, a `turn.started` hook that cannot load the caller's credentials can stop the turn before the model runs, instead of letting every tool call fail:

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
        ctx.cancel();
      }
    },
  },
});
```

The remaining subscribers for the event still run. Then eve cancels the turn the same way [`session.cancel()`](./client/streaming) does: in-flight model and tool work is aborted, delegated child turns are cancelled, and the turn settles with `outcome: "cancelled"` and `cause: { hook }` naming the hook. No failure is recorded. A cancel from `turn.started` or `model.requested` takes effect before that model call. In a conversation, the next message starts a new turn. A delegated task reports the cancellation to its caller.

`ctx.cancel()` returns `void` rather than a promise. The turn stops after the hook returns, so there is nothing to await. Call it before the handler's promise settles: eve ignores a call from work the handler does not await and logs a warning.

`ctx.cancel()` only stops a running turn. eve logs a warning and ignores the call on settlements that would give their work a second end (`turn.settled`, `delivery.settled`, `interaction.settled`, `response.settled`, `task.ended`, `session.ended`), on `turn.paused`, `task.started`, and `child.opened`, and during clear or compact requests.

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
