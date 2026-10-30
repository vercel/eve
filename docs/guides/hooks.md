---
title: "Hooks"
description: "Subscribe to runtime stream events from agent/hooks/."
---

A hook runs your code after the agent records an event on its session stream, such as a session starting or a turn ending. Each hook is a file under `agent/hooks/`. Use hooks for audit logs, metrics and alerts, or copying sessions and messages to your own database. A hook sees events from every channel; to handle one channel's events, see [Scope side effects to a channel](#scope-side-effects-to-a-channel).

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

The hook's name is its path without the extension: `agent/hooks/audit.ts` is `"audit"`, and `agent/hooks/auth/load-profile.ts` is `"auth/load-profile"`. `defineHook`, `HookDefinition`, and `HookContext` come from `eve/hooks`.

The `events` map keys each handler by event type, and `*` matches every event. Any event in [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming) works, such as `session.started`, `turn.settled`, `content.completed`, and `call.settled`. Progress events (`content.delta`, `call.input`, and `call.progress`) reach only handlers keyed on their exact type, never `*`.

Handlers can call external services, cancel the running turn, and [continue a finished turn](#continue-a-turn-from-a-hook) with a new message. They can't add text to the model's context. To add model context at runtime, use `defineDynamic` and `defineInstructions` in `agent/instructions/`.

## Hook structure and context

Every handler receives a `HookContext`, which includes the shared [session context](./session-context) helpers. `HookContext<K>` is keyed by the handler's event key. Only `turn.settled` and `*` handlers get `continue`, so type a helper that calls it as `HookContext<"turn.settled">`:

```ts
type HookContext<K extends HookEventKey = HookEventKey> = HookBaseContext &
  (K extends "turn.settled" | "*" ? HookContinue : {});

interface HookContinue {
  continue(message: MessageContent, options?: HookContinueOptions): HookContinueResult;
}

interface HookBaseContext extends SessionContext {
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

- `ctx.turn` is the latest turn, including one that ended, or `null` before the first turn.
- `ctx.now` is the time eve recorded the event.
- `ctx.memo(key, fn)` follows the [dynamic-value memo rules](./dynamic-capabilities#memo-rules).
- `ctx.view` is a read-only snapshot of the session, taken with the event. Read what changed from the event and where things stand from the view. On `call.settled`, `call(ctx.view, event.data.callId)` from `eve/events` returns the call's name, kind, input, output, and state.
- Hooks don't receive the assembled conversation history.

For `task.started`, `task.ended`, and `child.opened`, `ctx.session.id` is the session that started the task or opened the child session, even when the event arrives between turns. These hooks can call `ctx.getSandbox()` on that session, and their state and sandbox changes carry into its next turn.

A hook can stop the session's sandbox at a point you choose:

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

Every built-in sandbox backend stops the compute but keeps the session and its filesystem. On Vercel, the sandbox starts again on its next use. A failed stop follows the normal [hook failure behavior](#what-happens-when-a-hook-throws).

### Narrowing tool results

`toolResultFrom` from `eve/tools` checks whether a finished call came from a specific authored tool or MCP or OpenAPI connection, and returns its typed output. Pass it the result of `call(ctx.view, callId)`:

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

| Call                            | `toolResultFrom` returns                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Doesn't match, or didn't finish | `undefined`                                                                    |
| Authored tool                   | `{ output, toolName, callId }`, with `output` typed as the tool's `TOutput`    |
| Connection                      | `{ output, toolName, connectionToolName, callId }`, with `output` as `unknown` |

`toolResultFrom` matches by tool definition, not name, so it also works for tools from a mounted extension. Import the tool from the extension's `./tools` export:

```ts
import { search } from "@acme/crm/tools";
import { call } from "eve/events";

// inside "call.settled":
const crmSearch = toolResultFrom(call(ctx.view, event.data.callId), search); // typed; matches crm__search
```

When one definition is mounted under several names, such as when a subagent re-exports an extension tool, `toolResultFrom` matches all of them.

### Persist events to your own database

`ctx.position` is the event's place on the stream. A position never changes, so `(session, line, index)` works as a primary key for an events table:

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

Reading the stream again yields the same positions, so the key removes duplicates. After an interruption, eve doesn't run hooks again for events it already published. Some handlers for an event may have run and others not, so effects are not exactly-once.

Pass `ctx.occurrence.idempotencyKey`, which identifies this handler's run for this event, to services that support idempotency. For one effect per turn or call, key on `turnId` or `callId` instead. An effect such as one alert per session needs state you store yourself. `ctx.memo` caches lookups, not records of effects, and a deployment change can discard it.

See [Positions](../concepts/sessions-runs-and-streaming#positions) for the full contract.

## Execution order

eve handles each recorded line of the stream in this order:

1. Write. The line is saved to the session stream.
2. Channel. The channel's handler runs for each event.
3. Hooks. Typed handlers run first, then `*` handlers. Return values are ignored.
4. Cancellation. A cancel requested with `ctx.cancel()` takes effect after the handlers return.

Hooks run after the line is saved, so a hook that throws can't corrupt the stream. [Dynamic functions](./dynamic-capabilities) don't subscribe to events; they run before each model call.

## What happens when a hook throws

An unhandled error fails the running turn before its next model call, or when the turn would end. Between turns, eve only logs the error. Catch errors from optional audit or metrics work if the turn should continue. To stop without a failure, call [`ctx.cancel(reason?)`](#cancel-the-running-turn-from-a-hook).

eve doesn't retry a failed hook or undo the state changes and side effects it made before the error. Handle retries or compensation inside the hook. Runtime failures outside the handler, such as context setup or saving state, still propagate.

## Cancel the running turn from a hook

Call `ctx.cancel(reason?)` when a hook finds that the turn can't continue. For example, a `turn.started` hook that can't load the caller's credentials can stop the turn before the model runs:

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

The event's other handlers still run. Then eve cancels the turn as [`session.cancel()`](./client/streaming) does:

- eve stops model and tool work in progress.
- eve cancels child turns the turn delegated to.
- The turn ends with `outcome: "cancelled"` and `cause: { hook }` naming the hook, and eve records no failure.

A cancel from `turn.started` or `model.requested` takes effect before that model call. In a conversation, the next message starts a new turn. A delegated task reports the cancellation to its caller.

Rules for `ctx.cancel()`:

- It returns `void`, because the turn stops after the hook returns.
- Call it before the handler's promise resolves. A call from work the handler didn't await throws.
- A handler that calls `ctx.cancel()` and then throws fails the turn instead.
- It targets the current turn, including while eve still accepts the turn's input. Between turns with no incoming turn, it does nothing.
- Repeated calls cancel that turn once and never a later turn.
- `ctx.compact` and `ctx.once` aren't available in hooks.

A plain-text answer to a pending question, such as one from `ask_question`, is recorded as `delivery.consumed` before the question receives it. Only the turn's own sender can answer by text; anyone else's text waits and runs as its own turn. The answer updates the claims on `ctx.session.auth.current` for that event's hooks and the rest of the turn, as a follow-up message does. Calling `ctx.cancel()` from that event's hook cancels the turn: the question ends as `interrupted`, and the waiting tool call never gets the text. In the same way, `ctx.cancel()` from a hook for a workflow tool's `call.progress` cancels the turn, and the run's result never reaches the model.

## Scope side effects to a channel

A hook under `agent/hooks/` sees matching events from every channel on the root agent. To run a handler only for sessions from one channel, put it in that channel's `events` configuration:

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

On a built-in channel, your handler replaces the channel's default handler for the same event key. Check the channel page before you override events that send replies, progress, errors, or prompts for human input. The [Slack channel](/docs/channels/slack#customize-rendering) takes renderers instead: a renderer keeps Slack's default by calling `next()` and replaces it by skipping `next`.

To check the channel inside a global hook, use `isChannel` from `eve/channels`, not `ctx.channel.kind`. The kind comes from the file path: `agent/channels/github.ts` reports `channel:github`, so `ctx.channel.kind === "github"` never matches. `isChannel` works for every channel, including route-only channels without event handlers:

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

Use `isChannel` the same way to get typed channel metadata in dynamic functions or instrumentation; see [OpenTelemetry runtime context](../observability/otel#add-runtime-context).

## Continue a turn from a hook

Call `ctx.continue(message, options?)` from a `turn.settled` handler to start the session's next turn. This hook keeps the agent working until the tests pass, for at most ten more turns:

```ts title="agent/hooks/until-green.ts"
import { defineState } from "eve/context";
import { defineHook } from "eve/hooks";

const attempts = defineState("until-green.attempts", () => 0);

export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      if (event.data.outcome !== "completed") return;
      const sandbox = await ctx.getSandbox();
      const test = await sandbox.run({ command: "pnpm test --reporter=dot" });
      if (test.exitCode === 0 || attempts.get() >= 10) {
        attempts.update(() => 0);
        return;
      }
      attempts.update((n) => n + 1);
      ctx.continue(
        `Tests still fail. Fix them without editing test files.\n\n${test.stdout.slice(-2000)}`,
      );
    },
  },
});
```

Only `turn.settled` and `*` handlers receive `ctx.continue`. The message is [`MessageContent`](./client/messages), and `options` takes `context` and `auth`, as `session.send()` does. Without `auth`, the continuation names no sender and the turn runs as the session's current identity.

The continuation waits until the session is idle, then starts an ordinary turn. It's dropped if anything else starts a turn first, such as a person's message, or if the session is cancelled, cleared, or ended, so a person can always stop a loop. Its `delivery.admitted` records `source: { channel, hook }`, and a note in the turn's history tells the model no person wrote it. Like other hook effects, a continuation is lost if the step that settled the turn is interrupted before it's saved. Bound loops yourself, as the example does.

A turn can be continued when it completed, or when the same hook cancelled it, so a hook can `ctx.cancel()` the agent mid-turn and continue with a correction. When several hooks continue the same turn, their messages share the next turn.

`ctx.continue()` returns `{ queued: true }`, or `{ queued: false, reason }` when it can't continue the turn: `not-completed`, `already-queued`, `auth-conflict` (another hook's continuation acts for a different sender), or `not-settled` (a `*` handler on another event).

## Subagent isolation

A subagent can have its own `agent/hooks/` directory. Its hooks run only for the subagent's turns and see only its context. Parent hooks don't run for subagent turns.

A subagent's approvals, questions, and sign-ins appear on the parent stream as the parent's own `interaction.opened` events. Parent hooks see them with the parent's session, agent, and channel context. In a relayed request:

- `subject` names the parent call that waits on it.
- `origin` names the child session and request, and `origin.call` names the child's call.

While the parent's turn waits on that child, the relayed request makes it wait for the person too. When the child's request ends, the parent stream records `interaction.settled`.

## Hook vs tool vs provider

| Need                                            | Use                                            |
| ----------------------------------------------- | ---------------------------------------------- |
| Watch runtime events (audit, metrics, alerting) | `events.<type>` (or a channel handler)         |
| Start the next turn after one finishes          | `ctx.continue()` from `events["turn.settled"]` |
| Give the model structured input on demand       | a tool                                         |
| Add model context at runtime                    | `defineDynamic` with `defineInstructions`      |
| Subscribe to platform-specific events           | a channel handler                              |

Hooks and channel event handlers have the same shape. When both handle an event, both run.

## What to read next

- [Tools](../tools)
- [Context control](../concepts/context-control)
- [Session context](../reference/typescript-api)
- [Sessions, runs and streaming](../concepts/sessions-runs-and-streaming)
