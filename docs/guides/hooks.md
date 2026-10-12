---
title: "Hooks"
description: "Run side effects from agent/hooks/ for each stream event, or when the session changes."
---

Hooks are eve's authored extension points for the runtime event stream. A hook runs side effects after eve durably records what the session did, such as audit logging, metrics and alerting, persisting every session and message to your own database, or compacting a session that went idle. Reach for one to act on what the agent does without writing a tool, a context provider (a value made available across a step), or a channel adapter handler (a handler defined on a channel's adapter; see [Channels](../channels/overview)).

A hook takes one of two forms:

- `events` handlers run once for each fact of a type, such as each `call.settled`.
- `select` with `run` runs once each time what `select` reads changes, such as when the session goes idle.

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

`defineHook`, `cancel`, `compact`, `HookDefinition`, and `HookContext` live on `eve/hooks`.

A hook file declares stream-event subscribers under the `events` map, keyed by fact type, with `*` matching every fact. Subscribe to any fact in the v27 catalog documented in [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming), such as `session.started`, `turn.settled`, `content.completed`, and `call.settled`. Progress records (`content.delta`, `call.input`, `call.progress`) reach only handlers keyed on their type, never `*`. A handler can return [`cancel()` or `compact()`](#cancel-or-compact-from-a-hook), but it cannot add model context. To contribute runtime model messages, use `defineDynamic` and `defineInstructions` in `agent/instructions/`.

## Run when the session changes

Use `select` with `run` when a side effect depends on where the session stands rather than on one fact. `select` reads the [session view](../concepts/sessions-runs-and-streaming) and returns JSON; eve calls `run` once each time that selection changes, after the commit that changed it:

```ts title="agent/hooks/compact-when-idle.ts"
import { compact, defineHook } from "eve/hooks";

export default defineHook({
  select: (view) => ({
    idle: view.turn !== null && view.turn.status === "settled",
    turnId: view.turn?.id ?? null,
  }),
  run: ({ idle }) => (idle ? compact({ reason: "The session went idle." }) : null),
});
```

`select` is synchronous and deterministic, like a [dynamic capability's](./dynamic-capabilities#select-what-the-capability-depends-on). It reads `view.turn`, `view.latest`, the session's tables, and `ctx.session` and `ctx.channel`, but not `view.model`, because hooks run before the session's capabilities. A `select` that reads `view.messages` runs only in steps that hold the conversation: steps that settle background work between turns skip it.

`run` receives the selection and a context with the session, agent, channel, `getSandbox()`, an `abortSignal`, and `await ctx.messages()` for the conversation, which throws in steps that settle background work between turns. It may await, and it may return [intents](#cancel-or-compact-from-a-hook). A selection that comes back later, as `false`, `true`, `false`, then `true` again does, runs `run` again: each new selection is a new occurrence.

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

Use `ctx.channel.kind` inside a global hook only when the operation is otherwise agent-wide and conditional handling is intentional. For typed channel metadata in dynamic capabilities or instrumentation, import the channel definition and narrow with `isChannel`; see [OpenTelemetry runtime context](../observability/otel#add-runtime-context).

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
  /** This handler's occurrence: `id` keys a side effect that must happen once. */
  readonly occurrence: { readonly id: string };
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

### Side effects that must happen once

Pass `ctx.occurrence.id` as the idempotency key of a side effect that must happen once, such as a charge, an email, or a ticket. A retried step runs the hook again with the same `id`, and a new occurrence gets a new one: for an `events` handler, each fact it receives; for `select` with `run`, each new selection.

```ts title="agent/hooks/notify-owner.ts"
import { defineHook } from "eve/hooks";
import { notifyOwner } from "../lib/notifications";

// Each time the turn pauses for a person, notify the session's owner once.
export default defineHook({
  select: (view) => view.turn?.status === "paused",
  run: async (paused, ctx) => {
    if (!paused) return;
    await notifyOwner({ idempotencyKey: ctx.occurrence.id, sessionId: ctx.session.id });
  },
});
```

eve cannot make an external call exactly-once: the service must accept the key and ignore a repeat.

See [Positions](../concepts/sessions-runs-and-streaming#positions) for the full contract.

## Execution order

When a session commits facts while it runs, the step that owns the session does these things in order:

1. Write. The line is written to the durable stream.
2. Channel delivery. The channel adapter handler runs for each fact.
3. Hooks. Each hook's `events` handlers run for each fact (typed handlers first, then the `*` wildcard), and each `select` with `run` runs if its selection changed.
4. Intents. eve acts on the `cancel()` and `compact()` intents hooks returned.

Dynamic capabilities are evaluated later, before the next model call, so a hook that cancels the turn stops it before any capability fetches data. Hooks always run after the line is durably recorded, so if a hook throws, the stream stays consistent.

## What happens when a hook throws

A hook that throws during a turn fails the turn. eve logs the failure with the hook and turn, runs the session's remaining hooks, and fails the turn before its next model call, or as it would settle. A hook that throws between turns has no turn to fail, so eve logs the failure and the session continues.

eve does not run a failed occurrence again later, so a side effect meant for one moment doesn't happen at another. The workflow's own retry of an interrupted step still runs the hook again with the same `ctx.occurrence.id`. State changes and external side effects made before the exception are not rolled back.

A hook that should not fail its turn, such as an optional observer or metrics exporter, catches its own errors:

```ts title="agent/hooks/metrics.ts"
import { defineHook } from "eve/hooks";
import { recordMetric } from "../lib/metrics";

export default defineHook({
  events: {
    async "call.settled"(event) {
      try {
        await recordMetric("call.settled", { outcome: event.data.outcome });
      } catch (error) {
        console.warn("metrics export failed", { error });
      }
    },
  },
});
```

## Cancel or compact from a hook

A hook asks the session to act by returning an intent. Return `cancel()` to stop the running turn, or `compact()` to compact the conversation before the next model call. A hook may return one intent, an array, or nothing. Each intent acts once for the occurrence that returned it.

For example, a `turn.started` hook that cannot load the caller's credentials can stop the turn before the model runs, instead of letting every tool call fail:

```ts title="agent/hooks/require-credentials.ts"
import { cancel, defineHook } from "eve/hooks";
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
        return cancel("Workspace credentials are unavailable.");
      }
    },
  },
});
```

eve cancels the turn the same way [`session.cancel()`](./client/streaming) does: in-flight model and tool work is aborted, delegated child turns are cancelled, and the turn settles with `outcome: "cancelled"` and `cause: { hook }` naming the hook. No failure is recorded. In a conversation, the next message starts a new turn. A delegated task reports the cancellation to its caller.

`cancel()` stops only the turn running when the hook returns it. Returned when no turn is running, such as from `turn.settled`, it does nothing. When the commit that ran the hook can't stop the turn, the cancel waits for the next one that can, while that turn still runs.

`compact()` compacts the conversation before the next model call, and once for each occurrence that returns it: a hook that compacts whenever the session goes idle compacts once per idle stretch.

## Subagent isolation

Subagents may carry their own `agent/hooks/` directory. Subagent hooks fire only inside the subagent scope. Parent-agent hooks do not fire for subagent turns, and subagent hooks see only the subagent's own context.

A subagent's approvals, questions, and sign-ins are also relayed to the parent stream, as the parent's own `interaction.opened` facts. Parent hooks observe them after the stream write, with the parent's session, agent, and channel context. A relayed interaction's `subject` names the parent call that waits on it, and its `origin` names the child session and request that asked, with `origin.call` naming the child's call. When the parent's turn is paused on that child, the relayed request pauses it on the person too. The child's settlement is relayed as the parent's `interaction.settled`.

## Hook vs tool vs provider

| Need                                              | Use                                            |
| ------------------------------------------------- | ---------------------------------------------- |
| Observe runtime events (audit, metrics, alerting) | `events.<type>` (or a channel adapter handler) |
| Act when the session reaches a state              | `select` with `run`                            |
| Provide structured input to the model on demand   | a tool                                         |
| Make a value available across the entire step     | a context provider                             |
| Subscribe to platform-specific events             | a channel adapter handler                      |

Stream-event hooks and channel adapter event handlers are structurally identical. Choose the channel adapter handler when you are authoring adapter-specific behavior, and choose `events.*` when you are authoring agent-level behavior that should fire across every channel. Both fire when both are registered.

## What to read next

- [Tools](../tools)
- [Context control](../concepts/context-control)
- [Session context](../reference/typescript-api)
- [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming)
