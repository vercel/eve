---
title: "Session Context"
description: "Use ctx.session and runtime accessors inside eve-managed execution."
---

eve passes a runtime `ctx` to tool executors, hook handlers, channel event handlers, and connection auth and header resolvers. Use it to inspect the active session and reach resources bound to that execution.

| Accessor                     | Provides                                                  | Full guide                 |
| ---------------------------- | --------------------------------------------------------- | -------------------------- |
| `ctx.session`                | Session identity, turn metadata, auth, and parent lineage | This page                  |
| `ctx.getSandbox()`           | The current agent's live sandbox handle                   | [Sandbox](../sandbox)      |
| `defineState(name, initial)` | Durable typed state shared by runtime code in one session | [State](../concepts/state) |

These APIs work only during eve-managed runtime execution. Calling them during module evaluation, discovery, or a build throws.

## `ctx.session`

`ctx.session` describes the durable session and active turn:

```ts title="agent/tools/who_called_me.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Return the active session metadata.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return {
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
      turnSequence: ctx.session.turn.sequence,
      currentCaller: ctx.session.auth.current?.principalId,
      initiator: ctx.session.auth.initiator?.principalId,
      parentSessionId: ctx.session.parent?.sessionId,
      parentCallId: ctx.session.parent?.callId,
    };
  },
});
```

Public fields include:

- `id`: the durable session ID.
- `context`: the read-only application JSON object supplied at session creation, or `{}`.
- `turn.id`: the current turn ID.
- `turn.sequence`: the turn's position in the session.
- `auth.current`: the caller for the active inbound turn.
- `auth.initiator`: the caller that started the session.
- `parent`: the parent call, session, root session, and turn for a child subagent session.

Unprotected agents expose `auth.current` and `auth.initiator` as `null`. Top-level schedule sessions use the framework app principal (`principalId: "eve:app"`, `principalType: "runtime"`). See [Authentication](./auth-and-route-protection#what-reaches-ctxsessionauth) for how inbound identity becomes session auth.

## Application context

Pass `sessionContext` when creating a session to select behavior such as the UI surface:

```tsx
import { useEveAgent } from "eve/react";

const agent = useEveAgent({
  prewarm: true,
  sessionContext: { surface: "docs" },
});
```

React, Vue, and Svelte accept the same option. The hook captures it when its store is created and sends it with each new session, including prewarming and sessions created after `reset()`. Attaching or resuming an existing session preserves that session's original context. Remount the hook to change its creation context.

The TypeScript client accepts the same object with or without a first message:

```ts
const { session } = await client.sessions.create({
  sessionContext: { surface: "docs" },
});

await (await session.send("How do I configure redirects?")).result();
```

Read it through `ctx.session.context` in tools, hooks, connection resolvers, workflow tools, or dynamic definitions. For example, select instructions at session start:

```ts title="agent/instructions/surface.ts"
import { defineDynamic, defineInstructions } from "eve/instructions";

const surfaceInstructions = {
  docs: "Help the user understand the documentation.",
  dashboard: "Help the user manage their projects.",
};

export default defineDynamic({
  events: {
    "session.started": (_, { session }) => {
      const surface = session.context.surface;
      if (surface !== "docs" && surface !== "dashboard") {
        throw new Error("Expected a docs or dashboard surface.");
      }
      return defineInstructions({ content: surfaceInstructions[surface] });
    },
  },
});
```

`sessionContext` must be a JSON object. eve checks that boundary and persists it before initialization, so `session.started` can read it even when the session was prewarmed. It survives later turns, reconnects, and workflow steps. A later session POST cannot replace it. Sessions created without context expose `{}`; child sessions do not inherit their parent's context automatically.

There is no `defineAgent` schema or automatic application type inference. eve does not automatically include `session.context` in prompts: your instructions or tools choose what the model sees. Use [`clientContext`](./client/messages#send-a-full-turn-payload) for ephemeral per-turn model context, and [`defineState`](../concepts/state) for mutable session state.

## `ctx.getSandbox()`

Call `ctx.getSandbox()` when authored runtime code needs filesystem or process access in the current agent's sandbox:

```ts
const sandbox = await ctx.getSandbox();
const result = await sandbox.run({ command: "npm test" });
```

The accessor is asynchronous because eve may need to bind or restore the sandbox. A subagent sees its own sandbox, not its parent's. The returned handle also exposes `stop()` and `delete()`; see [Sandbox lifecycle](../sandbox#lifecycle) for their behavior.

When you need capabilities specific to the configured environment, pass its exported environment object. The return type preserves the environment's session capabilities. Provider-specific methods such as `setNetworkPolicy()` are not available from the no-argument accessor:

```ts
import { environment } from "../sandbox";

const sandbox = await ctx.getSandbox(environment);
await sandbox.setNetworkPolicy("deny-all");
```

The environment must be the one configured for the current sandbox. eve rejects a different environment instead of returning a handle with capabilities that may not exist.

## Custom state with `defineState`

Use `defineState` for durable per-session values that tools, hooks, and channel handlers share. Unlike the `ctx` accessors, import it from `eve/context` and declare the handle at module scope. Its `get()` and `update()` methods still require active eve execution. See [State](../concepts/state) for the read, update, reset, and subagent-isolation model.

## Where these APIs work

Runtime context is available:

- inside `defineTool(...).execute(input, ctx)`;
- inside connection `auth` and `headers` resolvers;
- inside channel and agent hook callbacks that receive the full runtime `ctx`;
- after asynchronous boundaries within the same authored execution chain.

Runtime context is not available during top-level module evaluation, build scripts, or discovery. Declare reusable definitions and state handles at module scope, but call their context-dependent methods only from an eve-managed callback.

## How it works

eve establishes the managed context before invoking authored runtime code and keeps it available across asynchronous work in that execution chain. The framework binds durable session data and step-local resources, then commits mutable state at the step boundary. Authored code uses the public accessors rather than managing this lifecycle.

## What to read next

- [State](../concepts/state): durable typed values scoped to one session.
- [Sandbox](../sandbox): runtime filesystem and process access.
- [Sessions, runs, and streaming](../concepts/sessions-runs-and-streaming): the durable session and event contract.
