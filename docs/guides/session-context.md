---
title: "Session Context"
description: "Use ctx.session and runtime accessors inside eve-managed execution."
---

The runtime `ctx` is the object eve passes to tool executors, hook handlers, channel event handlers, and connection auth and header resolvers. Use it to read the current session and reach resources for the code that is running.

| Accessor                     | Provides                                                  | Full guide                 |
| ---------------------------- | --------------------------------------------------------- | -------------------------- |
| `ctx.session`                | Session identity, turn metadata, auth, and parent lineage | This page                  |
| `ctx.getSandbox()`           | The current agent's live sandbox handle                   | [Sandbox](../sandbox)      |
| `defineState(name, initial)` | Typed state shared by runtime code in one session         | [State](../concepts/state) |

These APIs work only while eve runs your code. Calling them while a module loads, during discovery, or during a build throws.

## `ctx.session`

`ctx.session` describes the session and the active turn:

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

- `id`: the session ID.
- `turn.id`: the current turn ID.
- `turn.sequence`: the turn's position in the session.
- `auth.current`: the caller for the active inbound turn.
- `auth.initiator`: the caller that started the session.
- `parent`: the parent call, session, root session, and turn for a child subagent session.
- `predecessor`: present only when this session replaced a stranded one; `sessionId` names that earlier session. See [Recover a stranded session](./deployment/self-hosted-operations#recover-a-stranded-session) to read its earlier conversation.

Unprotected agents expose `auth.current` and `auth.initiator` as `null`. Sessions that a top-level schedule starts use eve's app identity (`principalId: "eve:app"`, `principalType: "runtime"`). See [Authentication](./auth-and-route-protection#what-reaches-ctxsessionauth) for how inbound identity becomes session auth.

## `ctx.getSandbox()`

`ctx.getSandbox()` returns a handle for filesystem and process access in the current agent's sandbox:

```ts
const sandbox = await ctx.getSandbox();
const result = await sandbox.run({ command: "npm test" });
```

The accessor is asynchronous because eve may need to attach or restore the sandbox. A subagent sees its own sandbox, not its parent's. The returned handle also exposes `stop()` and `delete()`; see [Sandbox lifecycle](../sandbox#lifecycle) for their behavior.

Pass the exported environment object to get methods specific to that environment. Provider-specific methods such as `setNetworkPolicy()` are not available from the no-argument accessor:

```ts
import { environment } from "../sandbox";

const sandbox = await ctx.getSandbox(environment);
await sandbox.setNetworkPolicy("deny-all");
```

The environment must be the one configured for the current sandbox; eve rejects any other.

## Custom state with `defineState`

`defineState` declares a per-session value that tools, hooks, and channel handlers share. The value survives crashes and redeploys. Import it from `eve/context` and declare the handle at module scope. Its `get()` and `update()` methods still work only while eve runs your code. See [State](../concepts/state) for the read, update, reset, and subagent-isolation model.

## Where these APIs work

Runtime context is available:

- inside `defineTool(...).execute(input, ctx)`;
- inside connection `auth` and `headers` resolvers;
- inside channel and agent hook callbacks that receive the full runtime `ctx`;
- after asynchronous boundaries within the same authored execution chain.

Declare reusable definitions and state handles at module scope, but call their context-dependent methods only from a callback that eve runs.

## How it works

eve sets up session data and per-step resources before your code runs. They stay available across asynchronous work in the same call chain. eve saves state changes at the end of the step.

## What to read next

- [State](../concepts/state): typed values that belong to one session.
- [Sandbox](../sandbox): runtime filesystem and process access.
- [Sessions, runs, and streaming](../concepts/sessions-runs-and-streaming): how sessions and their events work.
