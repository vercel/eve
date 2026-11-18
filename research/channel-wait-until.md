---
issue: https://github.com/vercel/eve/pull/6476
status: implemented
last_updated: "2026-11-15"
---

# Background work in channel event handlers

> **AI status:** Written entirely by AI; human review pending.

A turn waits for each channel event handler before it goes on. Most handlers need that: GitHub's
`turn.started` checks out the repository the model is about to read, and a reply has to post
after the status it replaces. A few don't. Slack's `turn.started` and `model.started` handlers
only refresh the thread status, yet their two Slack round trips sit in front of every model call.

Running every handler behind the turn removes that latency, but it also changes the ordering
contract for every channel, including authored ones that depend on it. Background work is
instead an explicit, per-call opt-in.

## Authoring API

`ChannelEventContext` gains one method:

```ts
events: {
  "model.started"(_event, ctx) {
    ctx.waitUntil(platform.showTyping(ctx.channel.state.threadId));
  },
},
```

```ts
interface ChannelEventContext<TChannel> {
  /** Lets the turn go on while `task` settles, instead of waiting for the handler. */
  readonly waitUntil: (task: Promise<unknown>) => void;
}
```

The name and shape follow `waitUntil` in Vercel Functions and service workers, and match the
`waitUntil` eve already hands route handlers: the caller has already started the work and only
asks the host to keep its scope alive until it settles.

The member is required. Under the stability policy, values eve passes into authored code can
gain members in a minor release, so this ships as `minor`; a test fixture that builds a
`ChannelEventContext` by hand needs to add it.

## Semantics

- **Handlers stay blocking.** Without `waitUntil`, nothing changes: the turn, hooks, and the
  model wait for the handler, in stream order.
- **Bounded lifetime.** eve drains the step's background work at the end of each model call's
  context scope, before the sandbox and session providers commit or dispose; before a turn
  step saves the session; before the checkpoint of a cancelled turn is serialized; and before
  the stream is released. A promise never outlives the sandbox, session, or checkpoint it
  belongs to.
- **State lands.** After draining, eve snapshots `ctx.channel.state` again, so changes the work
  made are saved with the step, including on cancel. `session.ended` saves nothing, since the
  session is over. A cancelled turn's checkpoint keeps the
  channel state its handlers left, as it already keeps hook state, because the stream keeps the
  events they handled.
- **Failures are logged.** A rejected promise is logged with the channel kind and event type and
  never fails the turn, matching how a throwing handler is already treated.
- **Bounded wait.** Each drain waits at most 30 seconds. Work still running then is logged with
  its event types and left behind, so a promise that never settles can't hold the step until the
  host times it out. Its later writes to channel state aren't isolated: they share the state
  object the step's other handlers use, so a later save in the same step may keep them, and
  they're lost once the step ends.
- **Closed after release.** Once the step releases the stream, a `waitUntil` call (from a
  handler that kept `ctx`) is logged and not waited for, rather than queued where nothing would
  drain it.
- **No ordering across handlers.** Later handlers, hooks, and the model don't wait for the
  promise. A channel whose later handlers must follow the work, such as a reply after a status,
  sequences that itself.
- **Outside a publisher** (unit harnesses that call a handler directly), the handler waits for
  its `waitUntil` work before it returns, with the same timeout, and logs rather than throws a
  rejection.

```
emit(line) ──▶ handler ──▶ hooks ──▶ … next model call
                 │
                 └─ waitUntil(p) ┄┄┄┄┄┄┄┄┄┄┄┄┐
                                             ▼
         end of model-call scope / save / cancel checkpoint / release: await p, save state
```

## Slack

Only the default `turn.started` and `model.started` handlers use `waitUntil`, for their status
writes. Status writes queue in order behind each other, and every other status write, the
reply, and `turn.settled` wait for the queue first, so the thread never shows a status after the
reply that cleared it. The first model run of a turn also skips its forced rewrite of the
`Thinking...` status `turn.started` just wrote; later runs still force it, since a tool may have
posted and cleared it. Every other Slack handler, and every other built-in channel, stays
blocking.
